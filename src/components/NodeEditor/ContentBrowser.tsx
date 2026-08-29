import { memo, useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { CATEGORIES } from '@/registry/nodeCategories';
import {
  getEditorDefinitions,
  categoryEmptiedByHiding,
  nodeMatchRank,
  NO_MATCH,
} from '@/registry/nodeRegistry';
import { isTextureHiddenFromEditor } from '@/registry/editorVisibility';
import { getBuiltinTextures, getBuiltinTextureIds } from '@/registry/builtinTextures';
import { getBuiltinPresets } from '@/registry/builtinPresets';
import { NodePreviewCard } from './NodePreviewCard';
import { SavedGroupCard } from './SavedGroupCard';
import { TextureCard } from './TextureCard';
import { PresetCard } from './PresetCard';
import { setHtml5TileDrag, endHtml5TileDrag } from './tileDrag';
import { useAppStore } from '@/store/useAppStore';
import { readPersisted, usePersistedState } from '@/hooks/usePersistedState';
import { beginDragChrome } from '@/utils/dragChrome';
import { setAssetBarHeight } from '@/utils/assetBarHeight';
import {
  registerAssetBarPush, cornerGripElement, gripClearance, readGripMetrics,
  maxBarHeightForCross, maxCrossForBarHeight, CROSS_MIN_TOP_RATIO,
} from '@/utils/splitClearance';
import { formatCategoryLabel, t } from '@/i18n';
import type { NodeCategory, NodeDefinition } from '@/types';
import { CAT_HEX } from '@/utils/colorUtils';
import complexityData from '@/registry/complexity.json';
import { ScrollArrow, useScrollArrows } from '@/components/Layout/ScrollArrows';
import './ContentBrowser.css';

// Exclude 'unknown' (the registry hides unknown defs, so the tab would always
// be empty). 'output' IS listed: the graph has at most one, but its tile is the
// way to FIND it — dropping (or clicking) it while an Output exists glides the
// view to the existing node instead of adding a second (see outputFocus.ts).
// The ready-made-asset tabs (Presets, Textures, Noise, DataViz) lead; the
// building-block categories follow in their canonical CATEGORIES order.
const ASSET_TABS_FIRST: NodeCategory[] = ['presets', 'texture', 'noise', 'dataviz'];
// …and a tab whose every entry has been switched off in node-editor.html goes
// with them: hiding the last unfinished node of a category would otherwise leave
// a tab that opens to "Nothing here yet.", which is exactly the unfinished look
// the checkbox exists to remove. Textures are counted by ID (getBuiltinTextureIds
// — the cheap accessor), never by building them: this runs at module scope and
// the ~84 ms texture parse is deliberately deferred to first use.
const allTexturesHidden = getBuiltinTextureIds().every(isTextureHiddenFromEditor);
const displayCategories = [
  ...ASSET_TABS_FIRST.map((id) => CATEGORIES.find((c) => c.id === id)!),
  ...CATEGORIES.filter(
    (c) => !ASSET_TABS_FIRST.includes(c.id) && c.id !== 'unknown',
  ),
].filter((c) => (c.id === 'texture' ? !allTexturesHidden : !categoryEmptiedByHiding(c.id)));
const costs = complexityData.costs as Record<string, number>;

/** Pseudo-category id for the user's saved-group library. */
type BrowserCategory = NodeCategory | 'all' | 'saved';

/**
 * Tab style for a colored category button. The active tab's bg + bottom
 * border match the items-area tint so it visually merges with the content
 * below (same trick the TSL/Script tabs use in the code editor).
 */
function tabStyle(hex: string, active: boolean): React.CSSProperties {
  if (active) {
    const body = `${hex}1A`;
    return { background: body, borderColor: `${hex}66`, borderBottomColor: body };
  }
  return { background: `${hex}15`, borderColor: `${hex}33` };
}

/** Tile-zoom bounds: 0.5× keeps headers legible, 2× keeps a tile per screen. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
/** Zoom step per classic mouse-wheel notch (multiplicative). */
const ZOOM_STEP = 1.15;
/**
 * Wheel→zoom exponent per scrolled px, tuned so one classic mouse notch
 * (~100px deltaY) equals ZOOM_STEP. Trackpad pinches and smooth Ctrl-scrolls
 * arrive as streams of SMALL-delta wheel events, so the factor must scale with
 * delta magnitude — a fixed step per event would slam the zoom to its bounds
 * in a fraction of a second.
 */
const WHEEL_ZOOM_K = Math.log(ZOOM_STEP) / 100;
/** Per-event px cap: a momentum fling shouldn't jump more than ~×1.5 at once. */
const WHEEL_PX_CAP = 300;
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * The tile scale is pinned to the TALLEST tile: zoom is whatever makes that
 * one tile exactly fill the strip. So the bar's height is the only tile-size
 * control — drag it taller and every tile grows until the tallest touches both
 * edges; drag it shorter and they shrink together — and no tile is ever cut
 * off by the bar's own height. Before this the causality ran the other way
 * (zoom set the tiles' layout height, which set the bar's content height), so
 * the two could never both be authoritative.
 *
 * The tallest tile is MEASURED (it depends on per-node designer heights in
 * customGlyphs, so it can't be derived from a constant); these are only the
 * pre-measurement fallbacks.
 */
const TILE_BASE_FALLBACK_H = 200;
const TABS_FALLBACK_H = 25;
/** Default bar height as a multiple of the tallest tile — tiles start large. */
const BAR_DEFAULT_SCALE = 1.35;
/** Canvas kept visible above the bar — also what keeps the grip reachable. */
const BAR_CANVAS_RESERVE = 120;
/** Floor when the tabs row hasn't been measured yet (its own height). */
const BAR_MIN_H = 28;

/** How long a run of discrete resizes (wheel notches, held arrows) keeps its
 *  origin for the row-seam push — see `discreteStartCross`. */
const DISCRETE_RESIZE_IDLE_MS = 400;
/**
 * Vertical chrome that shares the strip with a tile but is NOT part of the
 * measured tile box: the strip's own padding-top (--space-1) + padding-bottom
 * (--space-2), plus the tile's top margin (--space-2). All three sit INSIDE the
 * zoomed element, so they scale with the tile and belong in the denominator.
 *
 * Leaving them out made the TALLEST tile overflow the strip by exactly this
 * much at every bar height — which is what cut the node-count caption off the
 * preset and texture tiles once their taller previews made them the tallest.
 */
const STRIP_CHROME_V = 4 + 8 + 8;

/**
 * Tile scale for a bar height, given the chrome above the strip and the tallest
 * tile.
 *
 * `chromeH` is the tabs row PLUS the bar's own top border — the window seam.
 * `h` is a BORDER-BOX height (the inline `height` the drag writes, under the
 * app-wide `box-sizing: border-box`), so the seam is inside it and has to come
 * back out; leaving it in over-claims the strip by exactly the seam width and
 * the tallest tile is then clipped by that much, because the strip is
 * `overflow-y: hidden`. That is the same defect STRIP_CHROME_V documents having
 * already caused once. It only became visible when the seam went from 2px to
 * 4px to match the SplitPane dividers — and it is 12px on coarse pointers,
 * where the tiles are smallest to begin with.
 */
const zoomForHeight = (h: number, chromeH: number, tileH: number) =>
  clampZoom((h - chromeH) / ((tileH || TILE_BASE_FALLBACK_H) + STRIP_CHROME_V));

// Module-scope (stable identity) per the readPersisted/usePersistedState
// contract. validateCollapsed + validateZoom now exist ONLY to migrate the two
// legacy keys once, on first seed.
const validateCollapsed = (raw: string | null): boolean => raw === '1';
const validateZoom = (raw: string | null): number => {
  const v = parseFloat(raw ?? '');
  return Number.isFinite(v) ? clampZoom(v) : 1;
};
/** Valid asset-tab ids: the tabs actually RENDERED plus the two pseudo-tabs. An
 *  unknown/removed id (a category renamed between releases, one whose nodes are
 *  all hidden now, a hand-edited value) falls back to 'all' rather than
 *  selecting a tab that renders empty — which is why this reads
 *  `displayCategories` and not the raw CATEGORIES table: the two lists
 *  disagreeing is exactly how a returning user boots into a blank strip. */
const BROWSER_TABS = new Set<string>([
  'all', 'saved', ...displayCategories.map((c) => c.id),
]);
const validateBrowserTab = (raw: string | null): BrowserCategory =>
  raw && BROWSER_TABS.has(raw) ? (raw as BrowserCategory) : 'all';

const validateBarHeight = (raw: string | null): number | null => {
  const v = parseFloat(raw ?? '');
  return Number.isFinite(v) && v > 0 ? v : null;
};

// memo(): NodeEditor re-renders on every drag/scrub frame (it subscribes to
// s.nodes), and this ~70-tile strip takes no props — without memo the whole
// palette re-rendered at pointer rate for changes it can't observe.
export const ContentBrowser = memo(function ContentBrowser() {
  // Persisted: reopening the app on the tab you left is the expected behaviour
  // for a palette you return to constantly (same treatment the bar's height,
  // canvas colour and language already get).
  const [activeCategory, setActiveCategory] = usePersistedState<BrowserCategory>(
    'fs:assetTab',
    validateBrowserTab,
  );
  const [search, setSearch] = useState('');
  // Bar height, persisted — the single source of truth for how big the bar AND
  // its tiles are. Only the read seed goes through the shared helper; the write
  // side stays local because it is debounced (see the persist effect below),
  // which the write-per-change hook deliberately doesn't model.
  const [barHeight, setBarHeight] = useState<number>(() => {
    const stored = readPersisted('fs:assetBarHeight', validateBarHeight);
    if (stored != null) return stored;
    // Migrate the two controls this replaced, so returning users keep the size
    // they had: a collapsed bar becomes the minimum height, and a tile zoom
    // becomes the height that reproduces it.
    if (readPersisted('fs:assetBarCollapsed', validateCollapsed)) return BAR_MIN_H;
    const zoom0 = readPersisted('fs:assetZoom', validateZoom);
    return TABS_FALLBACK_H + TILE_BASE_FALLBACK_H * BAR_DEFAULT_SCALE * zoom0;
  });
  useEffect(() => {
    const t = window.setTimeout(() => {
      try { localStorage.setItem('fs:assetBarHeight', String(Math.round(barHeight))); } catch { /* private mode */ }
    }, 300);
    return () => window.clearTimeout(t);
  }, [barHeight]);
  // Measured layout constants the scale depends on (see zoomForHeight).
  // `tabsH` is the whole chrome above the tile strip — the tabs row AND the
  // bar's top border/seam — not the tabs row alone.
  const [tabsH, setTabsH] = useState(TABS_FALLBACK_H);
  const [tileH, setTileH] = useState(TILE_BASE_FALLBACK_H);
  /** False until the first real tile measurement replaces the fallback. */
  const measuredRef = useRef(false);
  const zoom = zoomForHeight(barHeight, tabsH, tileH);
  // Mirrors for the imperative drag path, which runs outside React's cycle.
  const metricsRef = useRef({ tabsH, tileH, zoom });
  metricsRef.current = { tabsH, tileH, zoom };
  // The first layout runs on the fallback font; re-measure once the
  // self-hosted woff2 subsets swap in (same document.fonts.ready re-fit
  // useFitText does) — the measurement effect below keys on this.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let live = true;
    document.fonts?.ready?.then(() => { if (live) setFontsReady(true); });
    return () => { live = false; };
  }, []);
  const savedGroups = useAppStore((s) => s.savedGroups);
  const language = useAppStore((s) => s.language);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  /**
   * Publish the live bar height so the corner grip's position clamp can keep
   * the grip off the bar (the min() on .fs-grip--v in styles/controls.css).
   * Written here AND imperatively from the drag, so the clamp tracks the bar
   * in real time — which is why it goes through the consumer registry rather
   * than a variable on :root (see utils/assetBarHeight.ts: a root-level
   * inherited custom property invalidates the whole document, every frame of
   * the gesture).
   */
  const publishBarHeight = useCallback((h: number) => {
    setAssetBarHeight(h);
  }, []);
  useEffect(() => {
    publishBarHeight(barHeight);
  }, [barHeight, publishBarHeight]);

  /**
   * Measure the tabs row and the tallest tile. getBoundingClientRect reports
   * VISUAL px (the strip's `zoom` is already folded in), so dividing by the
   * zoom in force recovers the tile's natural 1× height — which makes the
   * measurement independent of the zoom it feeds, and the loop convergent.
   * The 1px threshold stops sub-pixel layout noise from oscillating it.
   */
  useEffect(() => {
    const strip = scrollRef.current;
    if (!strip) return;
    const raf = requestAnimationFrame(() => {
      // Mid-drag: the DOM zoom is paintHeight's imperative value while
      // metricsRef.zoom is still the committed state, so dividing one by the
      // other would bake a bogus (inflated) high-water tileH. The gesture
      // owns the strip until pointerup; the commit render re-measures. The
      // corner grip's push paints through the same path, so it counts too.
      if (resizeRef.current || pushedRef.current) return;
      // Tabs row + the bar's top border. `clientHeight` excludes borders while
      // the rect includes them, so their difference IS the seam — measured
      // rather than read from --fs-seam, so it needs no knowledge of the token
      // or of the coarse-pointer bump.
      const rootEl = rootRef.current;
      const seam = rootEl ? Math.max(0, rootEl.getBoundingClientRect().height - rootEl.clientHeight) : 0;
      const nextTabs = tabsRef.current?.offsetHeight;
      if (nextTabs) {
        const nextChrome = nextTabs + seam;
        if (Math.abs(nextChrome - metricsRef.current.tabsH) > 1) setTabsH(nextChrome);
      }
      const z = metricsRef.current.zoom || 1;
      let tallest = 0;
      for (const child of Array.from(strip.children) as HTMLElement[]) {
        const h = child.getBoundingClientRect().height / z;
        if (h > tallest) tallest = h;
      }
      if (tallest <= 0) return;
      // High-water mark after the first real measurement: the base is the
      // tallest tile in the WHOLE library, not in the current tab. Otherwise
      // switching to a tab of short tiles (Textures, Saved Groups) would
      // rescale every tile in the strip. The default tab is 'all', so the
      // first measurement already sees the full set.
      const current = metricsRef.current.tileH;
      const next = measuredRef.current ? Math.max(current, tallest) : tallest;
      measuredRef.current = true;
      if (Math.abs(next - current) > 1) setTileH(next);
    });
    return () => cancelAnimationFrame(raf);
    // Only when the strip's CONTENTS can have changed — tab, query, library,
    // language, bar size, or this effect's own committed measurements (the
    // 1px thresholds make the self-triggered re-run converge). The dep-less
    // form re-swept getBoundingClientRect over every tile on each of
    // NodeEditor's per-drag-frame re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory, search, savedGroups, language, barHeight, tabsH, tileH, fontsReady]);

  /**
   * Live gesture state: bounds measured once at pointerdown, plus the latest
   * pending height and the rAF handle that coalesces paints to one per frame.
   */
  const resizeRef = useRef<{
    startY: number;
    startH: number;
    min: number;
    max: number;
    pending: number;
    raf: number;
    /** The span both columns share, and the clearance the corner grip needs
     *  below the row seam — measured once at pointerdown (see the push below). */
    span: number;
    clearance: number;
    /** The row split's ratio when the gesture began. The seam is pushed UP from
     *  here and returns to it if the bar shrinks again within the same drag — the
     *  mirror of SplitPane's `barH`. */
    startCross: number;
  } | null>(null);
  /** True while the CORNER GRIP is painting a height onto this bar (the push in
   *  the other direction). Same "the gesture owns the height" meaning as
   *  `resizeRef`, which is why every guard tests both. */
  const pushedRef = useRef(false);
  /** The push gesture's bar bounds, measured once (see the handle below). */
  const pushBoundsRef = useRef<{ min: number; max: number } | null>(null);
  /** This gesture's dragChrome end call (idempotent; no-op before any drag). */
  const endDragChrome = useRef<() => void>(() => {});

  /**
   * Paint a height imperatively mid-drag. State is committed once on pointerup:
   * every card runs its own ResizeObserver, so a state write per pointermove
   * would re-render ~70 tiles a frame.
   */
  const paintHeight = useCallback((h: number) => {
    if (rootRef.current) rootRef.current.style.height = `${h}px`;
    const { tabsH: tb, tileH: tl, zoom: committed } = metricsRef.current;
    const strip = scrollRef.current;
    if (strip) {
      // TRANSFORM, not `zoom`, for the duration of the gesture.
      //
      // `zoom` is an INHERITED computed-style property: every Length in the
      // subtree (font-size, padding, border-width) is stored pre-multiplied by
      // it, so changing it dirties the computed style of every descendant and
      // forces a full layout. Measured on the default tab, that is 1,709
      // elements re-laid-out per pointermove frame — plus a font-shaping and
      // vector-raster cache miss on all 68 tiles, since every frame lands on a
      // new fractional scale. That is the frame-rate collapse.
      //
      // `transform` is neither inherited nor a layout property: with the layer
      // promoted it is a compositor-only scale — zero style recalc, zero
      // layout. React's inline style still carries the COMMITTED zoom, so
      // dividing by it makes the on-screen result identical to what pointerup
      // will bake in.
      strip.style.transformOrigin = '0 0';
      strip.style.willChange = 'transform';
      strip.style.transform = `scale(${zoomForHeight(h, tb, tl) / (committed || 1)})`;
    }
    publishBarHeight(h);
  }, [publishBarHeight]);

  /**
   * Hand the strip back to `zoom`. Transform is visual only — it never grows
   * `scrollWidth`, so the horizontal scroll extents, `useScrollArrows`, and
   * `tileGhostZoom` (which parses the literal inline `zoom` string) would all
   * be wrong if it outlived the gesture. None of them are read mid-drag, which
   * is exactly what makes the swap safe.
   */
  const clearDragTransform = useCallback(() => {
    const strip = scrollRef.current;
    if (!strip) return;
    strip.style.transform = '';
    strip.style.transformOrigin = '';
    strip.style.willChange = '';
  }, []);

  /**
   * Drag bounds, measured live. The ceiling is the SMALLER of "leave a slice of
   * canvas" and "the height at which tiles hit ZOOM_MAX" — past the latter the
   * bar would grow without the tiles growing, i.e. pure dead space.
   */
  const measureBounds = useCallback(() => {
    // Floor at the tabs row PLUS the seam: dragging fully down leaves the
    // window edge, the tabs and the grip, which is what the removed ▾ collapse
    // used to produce. The seam has to be in the floor because the height being
    // bounded is a border-box one — without it the border eats into the tabs
    // row at the minimum, and the row does not shrink (flex-shrink: 0), so it
    // overflows the bar instead.
    const rootEl = rootRef.current;
    const seam = rootEl ? Math.max(0, rootEl.getBoundingClientRect().height - rootEl.clientHeight) : 0;
    const min = (tabsRef.current?.offsetHeight || BAR_MIN_H) + seam;
    const availableH = rootRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    const { tabsH: tb, tileH: tl } = metricsRef.current;
    const max = Math.min(availableH - BAR_CANVAS_RESERVE, tb + (tl + STRIP_CHROME_V) * ZOOM_MAX);
    return { min, max: Math.max(min, max) };
  }, []);

  /**
   * The span both columns share, and how much room the corner grip needs below
   * the row seam. Measured once per gesture rather than per frame: neither can
   * change while a pointer is captured (the window cannot be resized mid-drag,
   * and the grip's own size is token-driven).
   */
  const measureClearance = useCallback(() => ({
    span: rootRef.current?.parentElement?.clientHeight ?? 0,
    clearance: gripClearance(readGripMetrics(cornerGripElement())),
  }), []);

  /**
   * Take the row seam (the 3D-preview / code split) up with the bar, so the
   * corner grip stays welded to it instead of clamping and detaching — the
   * mirror of SplitPane's `pushAssetBar`.
   *
   * Returns the bar height that is actually reachable: once the seam is at its
   * own floor there is nowhere left to push, and the BAR is what has to stop.
   */
  /**
   * The row seam's ratio before the CURRENT RUN of discrete resizes began.
   *
   * The pointer drag gets this for free: it latches `startCross` at pointerdown
   * and drops it at pointerup, which is what lets `pushRowSeam` put the seam
   * back when the bar shrinks again inside one gesture. Wheel notches and arrow
   * presses have no such bracket, and re-reading the live ratio each time makes
   * that restore a NO-OP in one direction — notch N moves the seam to 0.43,
   * notch N+1 takes 0.43 as its own origin, and `Math.min(startCross, …)` can
   * never choose anything higher. The seam then ratchets up with no way back
   * short of grabbing the corner grip, while the identical in-and-out done with
   * this bar's own grip restores exactly.
   *
   * So a run latches on its first push and releases after a short idle — long
   * enough to span a trackpad pinch stream or a held arrow key, short enough
   * that a later, separate adjustment starts from where the user can see the
   * seam actually is.
   */
  const discreteCrossRef = useRef<{ cross: number; timer: number } | null>(null);
  const discreteStartCross = useCallback(() => {
    const held = discreteCrossRef.current;
    if (held) window.clearTimeout(held.timer);
    const cross = held ? held.cross : useAppStore.getState().rightSplitRatio;
    discreteCrossRef.current = {
      cross,
      timer: window.setTimeout(() => { discreteCrossRef.current = null; }, DISCRETE_RESIZE_IDLE_MS),
    };
    return cross;
  }, []);
  useEffect(() => () => {
    if (discreteCrossRef.current) window.clearTimeout(discreteCrossRef.current.timer);
  }, []);

  const pushRowSeam = useCallback((h: number, span: number, clearance: number, startCross: number) => {
    if (!(span > 0)) return h;
    const capped = Math.min(h, maxBarHeightForCross(CROSS_MIN_TOP_RATIO, span, clearance));
    const cross = Math.max(
      CROSS_MIN_TOP_RATIO,
      Math.min(startCross, maxCrossForBarHeight(capped, span, clearance)),
    );
    const store = useAppStore.getState();
    if (cross !== store.rightSplitRatio) store.setRightSplitRatio(cross);
    return capped;
  }, []);

  const handleResizeDown = useCallback((e: React.PointerEvent) => {
    const root = rootRef.current;
    if (!root) return;
    // Primary button only: a right-click press would otherwise start the drag
    // chrome and then the native context menu swallows the pointerup, leaving
    // the app-wide selection block and the resize cursor stranded on.
    if (e.button !== 0) return;
    // Stops the browser starting a text-selection drag from the press itself.
    e.preventDefault();
    const { min, max } = measureBounds();
    const startH = root.getBoundingClientRect().height;
    const { span, clearance } = measureClearance();
    resizeRef.current = {
      startY: e.clientY, startH, min, max, pending: startH, raf: 0,
      span, clearance, startCross: useAppStore.getState().rightSplitRatio,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    endDragChrome.current = beginDragChrome('row-resize');
  }, [measureBounds, measureClearance]);

  /**
   * Re-clamp to the pane. The CSS max-height caps the RENDERED box, but the
   * tile zoom is derived from `barHeight` — so after the window (or the outer
   * splitter) shrinks, a too-tall stored height would keep scaling tiles for a
   * box that no longer exists, and they'd be clipped. Pulling the state back
   * into range keeps the two in agreement.
   */
  useEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => {
      // Mid-gesture the height is owned by the drag (either this bar's own grip
      // or the corner grip pushing it), and a state write here would fight it.
      if (resizeRef.current || pushedRef.current) return;
      const { min, max } = measureBounds();
      // A SHRINKING window moves the row seam up proportionally (it is a ratio)
      // while the grip's clearance stays a fixed number of pixels — so a bar
      // that fitted a moment ago can stop fitting with no gesture involved.
      // Clamp rather than push: a window resize is not a deliberate request to
      // re-proportion the right-hand column.
      const { span, clearance } = measureClearance();
      const ceil = span > 0
        ? Math.min(max, maxBarHeightForCross(useAppStore.getState().rightSplitRatio, span, clearance))
        : max;
      setBarHeight((h) => (h > ceil ? Math.max(min, ceil) : h));
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [measureBounds, measureClearance]);

  /** Ctrl/Cmd+wheel (and macOS trackpad pinch) resizes the bar. */
  const changeHeight = useCallback((factor: number) => {
    const { min, max } = measureBounds();
    const { span, clearance } = measureClearance();
    // Read the live height from the DOM rather than from a `setBarHeight`
    // updater: pushing the row seam WRITES to the store, and a state updater
    // must stay pure (React calls it twice under StrictMode, which would push
    // the seam twice from one wheel notch).
    const current = rootRef.current?.getBoundingClientRect().height;
    if (current == null) return;
    const want = Math.max(min, Math.min(max, current * factor));
    // A wheel resize is as deliberate as a drag, so it pushes the row seam too —
    // otherwise the same bar height would be reachable one way and not the
    // other, which reads as the wheel being broken near the limit.
    setBarHeight(Math.max(min, pushRowSeam(want, span, clearance, discreteStartCross())));
  }, [measureBounds, measureClearance, pushRowSeam, discreteStartCross]);

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    const d = resizeRef.current;
    if (!d) return;
    // The bar grows upward, so a negative dy (dragging up) is a taller bar.
    d.pending = Math.max(d.min, Math.min(d.max, d.startH - (e.clientY - d.startY)));
    // Coalesce into ONE paint per frame: a 120Hz mouse (or a coalesced-event
    // burst) fires pointermove faster than the display refreshes, and every
    // extra call would be a wasted style/layout write nobody ever sees.
    if (d.raf) return;
    d.raf = requestAnimationFrame(() => {
      const live = resizeRef.current;
      if (!live) return;
      live.raf = 0;
      // The seam push belongs INSIDE the coalescing, not beside it: it is a
      // synchronous localStorage write plus a zustand `set` that re-renders
      // AppLayout, both SplitPanes and the whole NodeEditor tree — by far the
      // more expensive of this frame's two writes, and the one the comment
      // above is really about. Run per pointermove it would fire two or three
      // times per displayed frame on a 120Hz pointer.
      live.pending = Math.max(
        live.min,
        pushRowSeam(live.pending, live.span, live.clearance, live.startCross),
      );
      paintHeight(live.pending);
    });
  }, [paintHeight, pushRowSeam]);

  /**
   * The other half of the coupling: let the CORNER GRIP shrink this bar so it
   * never has to clamp and detach from its own seam (utils/splitClearance.ts).
   *
   * `push` deliberately goes through `paintHeight`, the same imperative path
   * this bar's own drag uses — the height drives the tile strip's inherited
   * `zoom`, so a React state write per pointermove would re-lay-out ~1,700
   * elements a frame. `commit` bakes the final value in once, at pointerup.
   */
  useEffect(() => registerAssetBarPush({
    height: () => rootRef.current?.getBoundingClientRect().height ?? 0,
    push: (px) => {
      // Bounds are measured once per push GESTURE, not per frame: `push` runs on
      // every pointermove of the corner grip's drag, and re-measuring would
      // interleave forced layout reads with the style writes of the frame
      // before it — the thrash `paintHeight` is written to avoid.
      const bounds = pushBoundsRef.current ?? (pushBoundsRef.current = measureBounds());
      const clamped = Math.max(bounds.min, Math.min(bounds.max, px));
      const current = rootRef.current?.getBoundingClientRect().height ?? clamped;
      // The common case by far: the grip is nowhere near the bar and there is
      // nothing to move. Costing that nothing is what keeps an ordinary corner
      // drag exactly as cheap as it was before the coupling existed.
      if (Math.abs(clamped - current) < 0.5) return current;
      pushedRef.current = true;
      paintHeight(clamped);
      return clamped;
    },
    commit: () => {
      pushBoundsRef.current = null;
      if (!pushedRef.current) return;
      pushedRef.current = false;
      // Read BEFORE dropping the transform, exactly as handleResizeUp does, so
      // the committed number is the one that was on screen.
      const finalH = rootRef.current?.getBoundingClientRect().height;
      clearDragTransform();
      if (finalH != null) setBarHeight(finalH);
    },
  }), [measureBounds, paintHeight, clearDragTransform]);

  const handleResizeUp = useCallback((e: React.PointerEvent) => {
    const d = resizeRef.current;
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    resizeRef.current = null;
    // Restore document chrome FIRST: if releasePointerCapture throws (a pointer
    // the browser already released), the cursor override and the app-wide
    // selection block must not be stranded on.
    endDragChrome.current();
    e.currentTarget.releasePointerCapture(e.pointerId);
    // Commit the gesture's final value, then drop the visual transform so the
    // committed `zoom` (applied by the render this schedules) takes over. Read
    // the height BEFORE clearing — the transform doesn't affect it, but the
    // ordering keeps the two independent.
    const finalH = rootRef.current?.getBoundingClientRect().height;
    clearDragTransform();
    if (finalH != null) setBarHeight(finalH);
  }, [clearDragTransform]);

  /**
   * Keyboard resize. The −/+ buttons this grip replaced were focusable, so
   * without this the asset bar's size (and therefore the tile scale) would be
   * pointer-only.
   */
  const handleResizeKey = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 48 : 16;
    let delta = 0;
    if (e.key === 'ArrowUp') delta = step;
    else if (e.key === 'ArrowDown') delta = -step;
    else if (e.key === 'Home') delta = Number.POSITIVE_INFINITY;
    else if (e.key === 'End') delta = Number.NEGATIVE_INFINITY;
    else return;
    e.preventDefault();
    const { min, max } = measureBounds();
    const { span, clearance } = measureClearance();
    // The grip is a real tab stop, so this is a first-class way to resize the
    // bar and has to take the row seam with it exactly as the drag and the
    // wheel do — without the push, one press of Home grows the bar straight
    // through the clearance boundary and the CSS backstop strands the corner
    // grip mid-canvas, which is the whole failure splitClearance.ts removes.
    // Live height off the DOM, not a `setBarHeight` updater: pushRowSeam writes
    // to the store and an updater must stay pure (see changeHeight).
    // Home/End pass ±Infinity, which the clamp below resolves to max/min.
    const current = rootRef.current?.getBoundingClientRect().height;
    if (current == null) return;
    const want = Math.max(min, Math.min(max, current + delta));
    setBarHeight(Math.max(min, pushRowSeam(want, span, clearance, discreteStartCross())));
  }, [measureBounds, measureClearance, pushRowSeam, discreteStartCross]);

  // Unmounting mid-drag would otherwise strand the cursor override and the
  // app-wide selection block with nothing left to clear them.
  useEffect(() => () => endDragChrome.current(), []);
  const tabsArrows = useScrollArrows(tabsRef);
  const itemsArrows = useScrollArrows(scrollRef);

  // getEditorDefinitions, not getAllDefinitions: nodes switched off in
  // node-editor.html ("In editor") must not have a tile here. See
  // registry/editorVisibility.ts. `output` is included — its tile doubles as
  // "take me to the Output" once one exists (placeTilePayload redirects the
  // drop; see outputFocus.ts), and its cost of 0 plus last-in-registry order
  // parks it at the end of the zero-cost run rather than at the strip's head.
  const allDefs = useMemo(() => getEditorDefinitions(), []);

  const q = search.trim().toLowerCase();

  // One shared match+rank rule with the Add-node menu (nodeRegistry.searchNodes),
  // so the same query orders the same way on both surfaces — a node's NAME
  // always outranks a node that merely mentions the query in its description.
  const rankDefs = useCallback(
    (defs: NodeDefinition[]) =>
      defs
        .map((d) => ({ d, rank: nodeMatchRank(d, q) }))
        .filter((e) => e.rank !== NO_MATCH)
        .sort((a, b) => a.rank - b.rank)
        .map((e) => e.d),
    [q],
  );

  const filteredDefs = useMemo<NodeDefinition[]>(() => {
    // saved/texture/presets render their own tiles; defs unused there.
    let defs: NodeDefinition[];
    if (
      activeCategory === 'all' || activeCategory === 'saved' ||
      activeCategory === 'texture' || activeCategory === 'presets'
    ) {
      defs = allDefs;
    } else {
      defs = allDefs.filter((d) => d.category === activeCategory);
    }
    // Cheapest first, everywhere — the strip reads as a difficulty/budget ramp,
    // and the GPU price is the one number every node tile already shows. (The
    // Noise tab was the only tab sorted this way; the rest kept registry order,
    // which is authoring order and means nothing to a reader.) Sorting a copy
    // keeps `allDefs`' identity stable for the other branches.
    defs = [...defs].sort((a, b) => (costs[a.type] ?? 50) - (costs[b.type] ?? 50));
    if (!q) return defs;
    const scoped = rankDefs(defs);
    // Fallback: if the active category has no matches, broaden to all node defs
    // so the user isn't left staring at an empty panel while typing.
    if (scoped.length === 0 && activeCategory !== 'all') return rankDefs(allDefs);
    return scoped;
  }, [allDefs, activeCategory, q, rankDefs]);

  const filteredSavedGroups = useMemo(() => {
    if (!q) return savedGroups;
    return savedGroups.filter((g) => g.name.toLowerCase().includes(q));
  }, [savedGroups, q]);

  /**
   * BOTH ready-made strips read cheapest-first, on the SAME number their tile
   * prints.
   *
   * `totalCost` is what `AssetCostBadge` draws, so the strip reads as a price
   * ladder you can scan — which is the point of a library whose whole pedagogy
   * is that a tier-3 look need not be expensive (Iridescence is 45 and cheaper
   * than the tier-2 Noise Mask at 49; Studio Shine is 78 and the priciest thing
   * here). Deliberately NOT `nodeCostPoints`: that re-derives a variadic fold's
   * price as base x (N-1) and can disagree with the badge by a point or two
   * (studio-shine 78 vs 76), and a sort that contradicts the number on screen
   * reads as a bug.
   *
   * This orders ACROSS tiers, so the strip is no longer the easy->advanced
   * ladder `PRESET_ENTRIES` still encodes — the tier survives in each preset's
   * card blurb and its in-frame note, not in the strip position.
   *
   * Textures used to sort by MEMBER COUNT instead, on the reasoning that a
   * texture is a graph you open and read so "how much is in it" predicts the
   * effort. Two strips sorted by two different rules is the thing that was
   * actually confusing: the number printed on a texture tile is its PRICE, and
   * a strip ordered by something the tile does not show reads as unordered.
   * They are one ladder now (Grid 22 -> Crumpled Fabric 510), and node count
   * turns out to be a poor proxy for it anyway — Static Noise is the smallest
   * texture at 16 nodes and the third most expensive of the cheap half.
   */
  const byCost = <T extends { totalCost: number; name: string }>(a: T, b: T) =>
    a.totalCost - b.totalCost || a.name.localeCompare(b.name);

  const filteredTextures = useMemo(() => {
    // Lazily built, same rule as the presets memo below: the first
    // getBuiltinTextures() call parses 8 TSL snippets through codeToGraph and
    // lays them out (tens of ms of synchronous Babel + dagre work — measured at
    // 84 ms when it runs first; whichever of the two getters runs first eats the
    // module warm-up), so don't pay it at first render for a tab that may never
    // open. A live search needs them too — matching textures surface in the
    // generic strip (see `items` below).
    if (activeCategory !== 'texture' && !q) return [];
    const all = getBuiltinTextures().filter((t) => !isTextureHiddenFromEditor(t.id)).sort(byCost);
    if (!q) return all;
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }, [q, activeCategory]);

  const filteredPresets = useMemo(() => {
    // Lazily built: the first getBuiltinPresets() call parses 24 TSL snippets
    // and lays them out (~40ms of synchronous work), so don't pay it at first
    // render for a tab that may never open. A live search needs them too —
    // matching presets surface in the generic strip (see `items` below).
    if (activeCategory !== 'presets' && !q) return [];
    // Sorted by GPU cost, NOT by the registry's tier order — see byCost.
    const all = [...getBuiltinPresets()].sort(byCost);
    if (!q) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q),
    );
  }, [q, activeCategory]);

  const onDragStart = useCallback((event: React.DragEvent, def: NodeDefinition) => {
    event.dataTransfer.setData('application/reactflow-type', def.type);
    event.dataTransfer.effectAllowed = 'move';
    // dataTransfer data is unreadable during dragover (spec), so record the
    // payload for NodeEditor's live drag-connect preview. Cleared on dragend
    // (the root div's endHtml5TileDrag catches every tile's dragend bubble).
    setHtml5TileDrag({ kind: 'node', nodeType: def.type });
  }, []);

  // Convert vertical scroll to horizontal scroll (native listener for non-passive).
  // On the items strip, Ctrl/Cmd+wheel (and macOS pinch, which arrives as a
  // ctrlKey wheel) resizes the bar — which is what scales the tiles.
  useEffect(() => {
    const els = [scrollRef.current, tabsRef.current];
    const handlers: (() => void)[] = [];
    for (const el of els) {
      if (!el) continue;
      const zoomable = el === scrollRef.current;
      const onWheel = (event: WheelEvent) => {
        if (zoomable && (event.ctrlKey || event.metaKey)) {
          event.preventDefault(); // keep the browser from page-zooming
          if (event.deltaY !== 0) {
            // Normalize deltaMode (0 px / 1 lines / 2 pages) to px, cap, and
            // map to an exponential factor so pinch streams zoom smoothly.
            const px = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
            const capped = Math.max(-WHEEL_PX_CAP, Math.min(WHEEL_PX_CAP, px));
            changeHeight(Math.exp(-capped * WHEEL_ZOOM_K));
          }
          return;
        }
        if (event.deltaY !== 0) {
          event.preventDefault();
          el.scrollLeft += event.deltaY;
        }
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      handlers.push(() => el.removeEventListener('wheel', onWheel));
    }
    return () => handlers.forEach((h) => h());
  }, [changeHeight]);

  const empty = (msg: string) => <div className="content-browser__empty">{msg}</div>;

  let items: React.ReactNode;
  if (activeCategory === 'saved') {
    items = savedGroups.length === 0
      ? empty('Right-click a group on the canvas → Save to Library to store it here.')
      : filteredSavedGroups.length === 0
        ? empty(`No saved groups match “${search.trim()}”.`)
        : filteredSavedGroups.map((g) => <SavedGroupCard key={g.id} group={g} />);
  } else if (activeCategory === 'texture') {
    items = filteredTextures.length === 0
      ? empty(`No textures match “${search.trim()}”.`)
      : filteredTextures.map((t) => <TextureCard key={t.id} texture={t} />);
  } else if (activeCategory === 'presets') {
    items = filteredPresets.length === 0
      ? empty(`No presets match “${search.trim()}”.`)
      : filteredPresets.map((p) => <PresetCard key={p.id} preset={p} />);
  } else {
    const defCards = filteredDefs.map((item) => (
      <NodePreviewCard key={item.type} def={item} onDragStart={onDragStart} />
    ));
    // A live search also surfaces matching ready-made assets after the node
    // defs — someone typing "dissolve" on the All tab must find the Dissolve
    // preset, which lives one tab away.
    const assetCards = q
      ? [
          ...filteredPresets.map((p) => <PresetCard key={`preset-${p.id}`} preset={p} />),
          ...filteredTextures.map((tx) => <TextureCard key={`texture-${tx.id}`} texture={tx} />),
        ]
      : [];
    // Show a message rather than a blank strip that reads as a rendering bug.
    items = defCards.length + assetCards.length === 0
      ? empty(q ? `No matches for “${search.trim()}”.` : 'Nothing here yet.')
      : [...defCards, ...assetCards];
  }

  return (
    <div
      ref={rootRef}
      className="content-browser"
      style={{ height: barHeight }}
      // Catches every tile's dragend bubble — including cancelled drags (Esc,
      // released outside the canvas) — so the drag payload record and any live
      // canvas previews are always torn down.
      onDragEnd={endHtml5TileDrag}
    >
      {/* Seam-height anchor pinned to the bar's top edge; the grip tab hangs
          off it and is the ONLY drag target. Dragging is now the only
          tile-size control (it replaced the −/+ zoom pair and the ▾ collapse). */}
      <div className="content-browser__resizer">
        <div
          className="fs-grip fs-grip--h"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('Resize asset bar', language)}
          title={t('Drag to resize — tiles scale with the bar', language)}
          tabIndex={0}
          onPointerDown={handleResizeDown}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeUp}
          onPointerCancel={handleResizeUp}
          onKeyDown={handleResizeKey}
        />
      </div>
      <div className="content-browser__scroll-wrapper">
        {tabsArrows.canLeft && <ScrollArrow direction="left" onClick={() => tabsArrows.scrollBy(-1)} />}
        <div className="content-browser__categories" ref={tabsRef}>
          <input
            className="content-browser__search"
            type="text"
            placeholder={t('Search…', language)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className={`content-browser__cat-btn ${activeCategory === 'all' ? 'content-browser__cat-btn--active' : ''}`}
            style={
              activeCategory === 'all'
                ? {
                    // Merges into the bar below, which is theme panel color —
                    // NOT the user's canvas pick (see ContentBrowser.css).
                    background: 'var(--bg-panel)',
                    borderColor: 'var(--border-subtle)',
                    borderBottomColor: 'var(--bg-panel)',
                  }
                : {}
            }
            onClick={() => setActiveCategory('all')}
          >
            {t('All', language)}
          </button>
          {displayCategories.map((cat) => (
            <button
              key={cat.id}
              className={`content-browser__cat-btn ${activeCategory === cat.id ? 'content-browser__cat-btn--active' : ''}`}
              style={tabStyle(CAT_HEX[cat.id], activeCategory === cat.id)}
              onClick={() => setActiveCategory(cat.id)}
            >
              {formatCategoryLabel(cat.label, cat.id, language)}
            </button>
          ))}
          <button
            className={`content-browser__cat-btn ${activeCategory === 'saved' ? 'content-browser__cat-btn--active' : ''}`}
            style={tabStyle(CAT_HEX.saved, activeCategory === 'saved')}
            onClick={() => setActiveCategory('saved')}
          >
            {t('Saved Groups', language)} {savedGroups.length > 0 ? `(${savedGroups.length})` : ''}
          </button>
        </div>
        {tabsArrows.canRight && <ScrollArrow direction="right" onClick={() => tabsArrows.scrollBy(1)} />}
      </div>
      <div className="content-browser__scroll-wrapper">
        {itemsArrows.canLeft && <ScrollArrow direction="left" onClick={() => itemsArrows.scrollBy(-1)} />}
        <div
          className="content-browser__items"
          ref={scrollRef}
          style={{
            background: activeCategory !== 'all'
              ? `${CAT_HEX[activeCategory]}1A`
              : undefined,
            zoom,
          }}
        >
          {items}
        </div>
        {itemsArrows.canRight && <ScrollArrow direction="right" onClick={() => itemsArrows.scrollBy(1)} />}
      </div>
    </div>
  );
});

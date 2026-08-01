import { useState, useMemo, useRef, useCallback, useEffect, type RefObject } from 'react';
import { CATEGORIES } from '@/registry/nodeCategories';
import { getAllDefinitions, nodeMatchRank, NO_MATCH } from '@/registry/nodeRegistry';
import { getBuiltinTextures } from '@/registry/builtinTextures';
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
import { formatCategoryLabel, t } from '@/i18n';
import type { NodeCategory, NodeDefinition } from '@/types';
import { CAT_HEX } from '@/utils/colorUtils';
import complexityData from '@/registry/complexity.json';
import './ContentBrowser.css';

// Exclude 'output' (the graph has at most one, not draggable from the palette)
// and 'unknown' (the registry hides unknown defs, so the tab would always be empty).
// The ready-made-asset tabs (Presets, Textures, Noise, DataViz) lead; the
// building-block categories follow in their canonical CATEGORIES order.
const ASSET_TABS_FIRST: NodeCategory[] = ['presets', 'texture', 'noise', 'dataviz'];
const displayCategories = [
  ...ASSET_TABS_FIRST.map((id) => CATEGORIES.find((c) => c.id === id)!),
  ...CATEGORIES.filter(
    (c) => !ASSET_TABS_FIRST.includes(c.id) && c.id !== 'output' && c.id !== 'unknown',
  ),
];
const costs = complexityData.costs as Record<string, number>;

/** Track overflow state of a horizontally scrollable element and provide scroll actions. */
function useScrollArrows(ref: RefObject<HTMLDivElement | null>) {
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, [ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [ref, update]);

  const scrollBy = useCallback(
    (dir: -1 | 1) => {
      ref.current?.scrollBy({ left: dir * 200, behavior: 'smooth' });
    },
    [ref],
  );

  return { canLeft, canRight, scrollBy };
}

function ScrollArrow({ direction, onClick }: { direction: 'left' | 'right'; onClick: () => void }) {
  return (
    <button
      className={`content-browser__arrow content-browser__arrow--${direction}`}
      onClick={onClick}
      aria-label={`Scroll ${direction}`}
    >
      {direction === 'left' ? '\u2039' : '\u203A'}
    </button>
  );
}

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

/** Tile scale for a bar height, given the measured tabs row + tallest tile. */
const zoomForHeight = (h: number, tabsH: number, tileH: number) =>
  clampZoom((h - tabsH) / ((tileH || TILE_BASE_FALLBACK_H) + STRIP_CHROME_V));

// Module-scope (stable identity) per the readPersisted/usePersistedState
// contract. validateCollapsed + validateZoom now exist ONLY to migrate the two
// legacy keys once, on first seed.
const validateCollapsed = (raw: string | null): boolean => raw === '1';
const validateZoom = (raw: string | null): number => {
  const v = parseFloat(raw ?? '');
  return Number.isFinite(v) ? clampZoom(v) : 1;
};
/** Valid asset-tab ids: the real categories plus the two pseudo-tabs. An
 *  unknown/removed id (a category renamed between releases, a hand-edited
 *  value) falls back to 'all' rather than selecting a tab that renders empty. */
const BROWSER_TABS = new Set<string>([
  'all', 'saved', ...CATEGORIES.map((c) => c.id),
]);
const validateBrowserTab = (raw: string | null): BrowserCategory =>
  raw && BROWSER_TABS.has(raw) ? (raw as BrowserCategory) : 'all';

const validateBarHeight = (raw: string | null): number | null => {
  const v = parseFloat(raw ?? '');
  return Number.isFinite(v) && v > 0 ? v : null;
};

export function ContentBrowser() {
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
  const [tabsH, setTabsH] = useState(TABS_FALLBACK_H);
  const [tileH, setTileH] = useState(TILE_BASE_FALLBACK_H);
  /** False until the first real tile measurement replaces the fallback. */
  const measuredRef = useRef(false);
  const zoom = zoomForHeight(barHeight, tabsH, tileH);
  // Mirrors for the imperative drag path, which runs outside React's cycle.
  const metricsRef = useRef({ tabsH, tileH, zoom });
  metricsRef.current = { tabsH, tileH, zoom };
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
      // owns the strip until pointerup; the commit render re-measures.
      if (resizeRef.current) return;
      const nextTabs = tabsRef.current?.offsetHeight;
      if (nextTabs && Math.abs(nextTabs - metricsRef.current.tabsH) > 1) setTabsH(nextTabs);
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
  });

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
  } | null>(null);
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
    // Floor at the tabs row: dragging fully down leaves tabs + grip, which is
    // what the removed ▾ collapse used to produce.
    const min = tabsRef.current?.offsetHeight || BAR_MIN_H;
    const availableH = rootRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    const { tabsH: tb, tileH: tl } = metricsRef.current;
    const max = Math.min(availableH - BAR_CANVAS_RESERVE, tb + (tl + STRIP_CHROME_V) * ZOOM_MAX);
    return { min, max: Math.max(min, max) };
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
    resizeRef.current = { startY: e.clientY, startH, min, max, pending: startH, raf: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    endDragChrome.current = beginDragChrome('row-resize');
  }, [measureBounds]);

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
      if (resizeRef.current) return; // mid-drag: the gesture owns the height
      const { min, max } = measureBounds();
      setBarHeight((h) => (h > max ? Math.max(min, max) : h));
    });
    ro.observe(parent);
    return () => ro.disconnect();
  }, [measureBounds]);

  /** Ctrl/Cmd+wheel (and macOS trackpad pinch) resizes the bar. */
  const changeHeight = useCallback((factor: number) => {
    const { min, max } = measureBounds();
    setBarHeight((h) => Math.max(min, Math.min(max, h * factor)));
  }, [measureBounds]);

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
      paintHeight(live.pending);
    });
  }, [paintHeight]);

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
    setBarHeight((h) => Math.max(min, Math.min(max, h + delta)));
  }, [measureBounds]);

  // Unmounting mid-drag would otherwise strand the cursor override and the
  // app-wide selection block with nothing left to clear them.
  useEffect(() => () => endDragChrome.current(), []);
  const tabsArrows = useScrollArrows(tabsRef);
  const itemsArrows = useScrollArrows(scrollRef);

  const allDefs = useMemo(() => {
    return getAllDefinitions().filter((d) => d.type !== 'output');
  }, []);

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
   * Ready-made assets read simplest-first, by MEMBER COUNT rather than by the
   * cost the node tiles sort on: an asset is a graph you are going to open and
   * read, so "how much is in it" is what predicts the effort, and points can
   * rank a 3-node voronoi above a 20-node arithmetic chain. `nodes` includes the
   * group container, so the +1 is constant and doesn't affect the order. Name
   * breaks ties so equal-sized assets keep a stable, non-arbitrary order.
   */
  const bySize = <T extends { nodes: { type?: string }[]; name: string }>(a: T, b: T) => {
    // Count only shader nodes — the frame and the explainer note are chrome.
    const n = (x: T) => x.nodes.filter((k) => k.type !== 'group' && k.type !== 'note').length;
    return n(a) - n(b) || a.name.localeCompare(b.name);
  };

  const filteredTextures = useMemo(() => {
    const all = [...getBuiltinTextures()].sort(bySize);
    if (!q) return all;
    return all.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }, [q]);

  const filteredPresets = useMemo(() => {
    // Lazily built: the first getBuiltinPresets() call parses 15 TSL snippets
    // and lays them out (~40ms of synchronous work), so don't pay it at first
    // render for a tab that may never open. A live search needs them too —
    // matching presets surface in the generic strip (see `items` below).
    if (activeCategory !== 'presets' && !q) return [];
    // Sorted by size, NOT by the registry's tier order. Size is a close proxy
    // for tier here (the tier-1 primitives are the small graphs) while also
    // ordering within a tier, and it keeps the two asset tabs consistent.
    const all = [...getBuiltinPresets()].sort(bySize);
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
      {/* Zero-height anchor pinned to the bar's top edge; the grip tab hangs
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
}

/**
 * The PURE model behind the app's colour picker (`PaletteColorPicker` /
 * `ColorPickerPopover`).
 *
 * The vitest environment is `node` with no jsdom, so the component itself can
 * never be rendered in a test. Everything in the picker that can be reasoned
 * about — which swatch rows exist, where the popover lands, which DOM node
 * hosts the portal, and how many recent colours one gesture records — therefore
 * lives HERE, as functions over plain data, and the component is left holding
 * only React wiring. This module must stay free of React, of the store, and of
 * any DOM access at import time (it is imported by a node-env test).
 */

import type { Palette } from '@/utils/palettes';
import { MAX_COLORS_PER_PALETTE } from '@/utils/palettes';
import { normalizeHex } from '@/utils/colorUtils';

/* ============================================================
 * Swatch sections
 * ============================================================ */

/** One labelled row-group of swatches in the popover. */
export interface PickerSection {
  /** React key. NEVER the bare palette id — see buildPickerSections. */
  key: string;
  name: string;
  colors: readonly string[];
  /** Per-colour labels, ALIGNED with `colors` (`''` where unnamed). Always
   *  materialized to the same length here, so the renderer can index it without
   *  a guard — a swatch tooltip is the one place a silent misalignment would
   *  read as correct software. */
  names: readonly string[];
  /** Shipped palette (read-only content) rather than one this shader owns. */
  builtin: boolean;
}

/**
 * The palette sections, in display order: the SHADER'S OWN palettes first, the
 * shipped ones below (the ordering `registry/builtinPalettes.ts` documents — a
 * shader sees the built-ins beneath whatever it has authored).
 *
 * Two defensive rules, both cheap and both real:
 *
 * 1. KEYS ARE PREFIXED. A palette id may be honoured straight out of a project
 *    block (`sanitizePalettes` keeps any id matching `[A-Za-z0-9_-]{1,64}` that
 *    is unique WITHIN that batch), so a hand-crafted `.fastshader` can carry a
 *    palette whose id is literally `builtin-ocean`. Keyed by the bare id, React
 *    would then see two children with the same key in one list. The `s:`/`b:`
 *    prefixes make a collision across the two groups impossible, and a
 *    duplicate inside one group falls back to its index.
 * 2. COLOURS ARE RE-WHITELISTED AND RE-CAPPED. Every swatch is rendered into
 *    `style.background`, so a non-hex string here would be CSS injection — the
 *    same reason `recentColors` and `sanitizePalettes` refuse anything but a
 *    literal 6-digit hex. Both of those clean their own input, so this is
 *    belt-and-braces at the RENDER boundary: it is what makes the component
 *    safe for a future caller that hands over a hand-built list, and it bounds
 *    a row the popover would otherwise have to scroll out of trouble.
 *
 * A palette with no colours is dropped rather than drawn as an empty row —
 * an empty row is indistinguishable from a rendering bug (the same call
 * `sanitizePalettes` makes when it refuses a colourless palette).
 */
export function buildPickerSections(
  shader: readonly Palette[] | undefined | null,
  builtins: readonly Palette[] | undefined | null,
): PickerSection[] {
  const out: PickerSection[] = [];
  const push = (list: readonly Palette[], prefix: string, builtin: boolean) => {
    const seen = new Set<string>();
    list.forEach((p, i) => {
      if (!p || !Array.isArray(p.colors) || p.colors.length === 0) return;
      // Colours and names are re-derived in ONE loop over the source indices,
      // the same rule `sanitizePalettes` follows: this function DROPS colours
      // (anything that is not a literal hex), so reading names in a second pass
      // would slide every later label onto the wrong swatch.
      const rawNames = Array.isArray(p.names) ? p.names : null;
      const colors: string[] = [];
      const names: string[] = [];
      for (let j = 0; j < p.colors.length; j += 1) {
        const hex = normalizeHex(p.colors[j]);
        if (!hex) continue;
        colors.push(hex);
        const label = rawNames?.[j];
        names.push(typeof label === 'string' ? label : '');
        if (colors.length >= MAX_COLORS_PER_PALETTE) break;
      }
      if (colors.length === 0) return;
      const id = typeof p.id === 'string' && p.id ? p.id : String(i);
      const key = seen.has(id) ? `${prefix}${id}#${i}` : `${prefix}${id}`;
      seen.add(id);
      out.push({ key, name: typeof p.name === 'string' ? p.name : '', colors, names, builtin });
    });
  };
  if (shader) push(shader, 's:', false);
  if (builtins) push(builtins, 'b:', true);
  return out;
}

/**
 * The tooltip for one swatch, shared by the popover and the Palettes dialog so
 * a colour reads identically wherever it is drawn.
 *
 * The hex is ALWAYS present, even when there is a name: the name is what makes
 * a swatch meaningful ("Gold" rather than `#ffe39d`), but the hex is what a
 * user copies out, and dropping it would make the labelled palettes strictly
 * less useful than the unlabelled ones they replaced.
 */
export function swatchTitle(hex: string, name?: string): string {
  const label = typeof name === 'string' ? name.trim() : '';
  return label ? `${label} — ${hex}` : hex;
}

/* ============================================================
 * Placement
 * ============================================================ */

/** Gap between the anchor and the popover. */
export const POPOVER_GAP = 4;
/** Minimum distance kept from every viewport edge. */
export const POPOVER_MARGIN = 4;

export interface AnchorBox {
  left: number;
  top: number;
  bottom: number;
}
export interface BoxSize {
  width: number;
  height: number;
}

/**
 * Where to put the popover, from the MEASURED rendered size — never from a
 * hardcoded height.
 *
 * The old implementation compared `below + 130` against `innerHeight` and
 * flipped to `r.top - 134`, two literals for a popover that was then always
 * four 5-swatch rows tall. It now carries a variable number of palettes (up to
 * the store's 16, each up to 64 colours) plus two rows of recents, so those
 * numbers describe a layout that no longer exists: a tall popover near the
 * bottom of the screen would have been "flipped above" to a position that still
 * clipped, with no way to scroll it back.
 *
 * Order of preference: below the anchor, then above it, then clamped into the
 * viewport (a popover taller than the viewport pins to the top margin — its own
 * `max-height` + `overflow-y` is what makes the rest reachable).
 */
export function placePopover(
  anchor: AnchorBox,
  size: BoxSize,
  viewport: BoxSize,
  gap: number = POPOVER_GAP,
  margin: number = POPOVER_MARGIN,
): { left: number; top: number } {
  const maxLeft = viewport.width - size.width - margin;
  const left = maxLeft < margin ? margin : Math.max(margin, Math.min(anchor.left, maxLeft));

  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  let top: number;
  if (below + size.height <= viewport.height - margin) {
    top = below;
  } else if (above >= margin) {
    top = above;
  } else {
    const maxTop = viewport.height - size.height - margin;
    top = maxTop < margin ? margin : Math.max(margin, Math.min(below, maxTop));
  }
  return { left, top };
}

/* ============================================================
 * Portal host
 * ============================================================ */

/** Anything the popover could be portalled into. Structural on purpose so the
 *  node-env test can hand this a plain object. */
export interface PortalHostLike {
  contains(other: Node | null): boolean;
}

/**
 * Which element the popover's portal must mount into.
 *
 * `document.body` is the right answer almost everywhere and the WRONG one in
 * the single case that matters: ShaderPreview fullscreens its own root element,
 * and the fullscreen top layer renders ONLY that element's subtree. A body
 * portal is not a descendant of it, so the popover would be invisible on
 * exactly the controls whose surrounding code goes out of its way to keep them
 * usable in fullscreen.
 *
 * The fullscreen element is adopted only when it actually CONTAINS the anchor —
 * a picker in the toolbar while the preview is fullscreen still belongs on the
 * body (it is unreachable either way, but it must not be re-parented into an
 * unrelated subtree).
 */
export function pickPortalHost<T extends PortalHostLike>(
  fullscreenEl: T | null | undefined,
  anchor: Node | null,
  body: T,
): T {
  if (!fullscreenEl || fullscreenEl === body || !anchor) return body;
  return fullscreenEl.contains(anchor) ? fullscreenEl : body;
}

/* ============================================================
 * Live-apply vs commit
 * ============================================================ */

/**
 * How long the picker waits after the last colour event before recording ONE
 * recent colour. Matches `useHistoryBracket`'s idle window so the undo bracket
 * and the recents commit close on the same beat.
 */
export const COMMIT_IDLE_MS = 600;

export interface ColorCommitStager {
  /** Remember a live value. Records NOTHING. */
  stage(hex: string): void;
  /** Record the staged value, once. No-op when nothing is staged. */
  flush(): void;
  /** Drop the staged value without recording it. */
  discard(): void;
  /** The staged value, for tests and for assertions at call sites. */
  peek(): string | null;
}

/**
 * Separates LIVE APPLY from COMMIT.
 *
 * A native `<input type="color">` fires a change event per frame while its
 * wheel is dragged, so a two-second drag is ~120 events. Recording each of them
 * would push ~120 near-identical shades through the 10-slot recent-colour MRU
 * and evict every colour the user had actually chosen — in ONE gesture, with
 * the eviction invisible until they next open a picker.
 *
 * The native `change` event is deliberately NOT the commit signal: browsers
 * disagree about whether it fires continuously during a wheel drag or only when
 * the dialog closes, so a design keyed to it floods on one engine and works on
 * the other. Staging plus an explicit flush (idle / blur / close / unmount) has
 * the same outcome on every engine.
 */
export function createColorCommitStager(commit: (hex: string) => void): ColorCommitStager {
  let pending: string | null = null;
  return {
    stage(hex: string) {
      pending = hex;
    },
    flush() {
      if (pending === null) return;
      const hex = pending;
      pending = null;
      commit(hex);
    },
    discard() {
      pending = null;
    },
    peek() {
      return pending;
    },
  };
}

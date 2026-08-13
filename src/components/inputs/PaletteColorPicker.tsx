import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';
import { useAppStore } from '@/store/useAppStore';
import { BUILTIN_PALETTES } from '@/registry/builtinPalettes';
import { clearRecentColors, getRecentColors, noteColorUsed } from '@/utils/recentColors';
import { normalizeHex } from '@/utils/colorUtils';
import { t } from '@/i18n';
import {
  buildPickerSections,
  COMMIT_IDLE_MS,
  createColorCommitStager,
  pickPortalHost,
  placePopover,
  swatchTitle,
  type ColorCommitStager,
} from './colorPickerModel';
import './PaletteColorPicker.css';

/** Safari still exposes fullscreen only under the webkit-prefixed name (the
 *  same shim ShaderPreview carries). */
type FsDocument = Document & { webkitFullscreenElement?: Element | null };

/**
 * Whether a pick is an UNDOABLE EDIT or a PREFERENCE.
 *
 * There is deliberately no default. `beginInteraction` — what `bracket()`
 * opens — takes a full graph snapshot AND clears `future`, so bracketing a
 * preference site (the canvas background, the draw-ink colour, the cost-gradient
 * poles, the preview background, a live uniform) would push an undo entry that
 * restores nothing and WIPE THE USER'S REDO STACK on every colour pick. Since
 * the picker is meant to be reachable from both kinds of site, the call site is
 * required to say which it is rather than inherit a guess.
 *
 *   'bracket' — the pick mutates the graph (a node value, an Output channel).
 *               Picks in quick succession coalesce into one undo entry.
 *   'none'    — the pick changes a preference that undo does not own.
 */
export type ColorPickHistory = 'bracket' | 'none';

/** Only one colour popover may be open app-wide. Mouse gets this for free —
 *  opening picker B fires a pointerdown that lands outside A and closes it —
 *  but KEYBOARD activation (Enter/Space on a focused swatch) fires a click with
 *  no pointerdown, so without this registry two popovers could stack at nearly
 *  the same fixed coordinates. */
let closeOpenPicker: (() => void) | null = null;

interface ColorPickerCoreProps {
  /** Current hex, or null when the site has no stored value yet. */
  value: string | null;
  /** Called on EVERY live value while a native picker wheel is dragged. */
  onPick: (hex: string) => void;
  /** When set, the popover leads with a reset entry that CLEARS the stored
   *  value — the site returns to its default (previewed as `clearColor`). This
   *  is how an Output-node normal override is re-applied to "default / none". */
  onClear?: () => void;
  /** The site's default colour, shown on the reset entry's swatch. */
  clearColor?: string;
  /** REQUIRED, no default — see ColorPickHistory. */
  history: ColorPickHistory;
}

export interface ColorPickerPopoverProps extends ColorPickerCoreProps {
  /** The element the popover is positioned against. Pointerdowns inside it
   *  never close the popover — that is the trigger's own business (a trigger
   *  button toggles; an invisible anchor simply ignores them). */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
}

/**
 * The popover ALONE — no trigger of its own.
 *
 * This is what makes the picker universal. The Color node's colour input is
 * `width: 0; height: 0; opacity: 0; pointer-events: none` and is opened
 * imperatively by a double-click / long-press on the node, because the node
 * itself IS the swatch (a circle whose perimeter carries the output socket).
 * There is nowhere on it to put the 26x12 trigger button, so a component that
 * insists on rendering one can never serve it. Sites like that render this
 * directly and own `open` themselves; `PaletteColorPicker` below is simply this
 * plus a trigger.
 */
export function ColorPickerPopover({
  value,
  onPick,
  onClear,
  clearColor,
  history,
  anchor,
  open,
  onClose,
}: ColorPickerPopoverProps) {
  const language = useAppStore((s) => s.language);
  // Cheap selector: every palette action REPLACES `shaderPalettes` (they are
  // never mutated in place) and history snapshots hold the same array BY
  // REFERENCE, so this identity is stable across every unrelated store notify
  // and the subscription bails on Object.is. A picker can be mounted on dozens
  // of nodes at once — building a merged array in the selector would allocate
  // one per notify per picker and re-render all of them.
  const shaderPalettes = useAppStore((s) => s.shaderPalettes);

  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  const popRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(
    () => buildPickerSections(shaderPalettes, BUILTIN_PALETTES),
    [shaderPalettes],
  );
  /** Compared against the (normalized) swatch hexes to ring the current one —
   *  a site storing `#FF0000` must still light up the `#ff0000` swatch. */
  const current = normalizeHex(value);

  // `onClose` is called from DOCUMENT listeners that are attached once per
  // open, so it is read through a ref — otherwise a parent that passes an
  // inline arrow (most of them) would tear down and re-attach three listener
  // pairs on every render. `onPick` deliberately does NOT get this treatment:
  // it is only ever called from JSX handlers, where a fresh closure costs
  // nothing and a ref would introduce a staleness window for no gain.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const closeSelf = useCallback(() => onCloseRef.current(), []);

  /** Whether the reset entry is drawn — a stable dep for the measure effect,
   *  which an inline `onClear` arrow would otherwise re-run per render. */
  const hasClear = Boolean(onClear);

  const { bracket, closeBracket } = useHistoryBracket();
  const brackets = history === 'bracket';

  /* ── live apply vs commit ────────────────────────────────────────────── */

  const idleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stagerRef = useRef<ColorCommitStager | null>(null);
  if (!stagerRef.current) {
    stagerRef.current = createColorCommitStager((hex) => {
      const next = noteColorUsed(hex);
      if (next) setRecents(next);
    });
  }

  const clearIdle = useCallback(() => {
    if (idleRef.current) {
      clearTimeout(idleRef.current);
      idleRef.current = null;
    }
  }, []);

  /** Record exactly ONE recent for the gesture that just ended. */
  const flushCommit = useCallback(() => {
    clearIdle();
    stagerRef.current?.flush();
  }, [clearIdle]);

  /**
   * Apply a value WITHOUT recording it. This is the per-frame path: a native
   * colour wheel fires ~60 events/second, all of which must reach `onPick` (the
   * live preview is the whole point) and none of which may touch the 10-slot
   * recents MRU. The idle timer is the commit signal that survives every
   * browser — see createColorCommitStager on why `change` is not.
   */
  const applyLive = useCallback(
    (hex: string) => {
      if (brackets) bracket();
      onPick(hex);
      stagerRef.current?.stage(hex);
      clearIdle();
      idleRef.current = setTimeout(() => {
        idleRef.current = null;
        stagerRef.current?.flush();
      }, COMMIT_IDLE_MS);
    },
    [brackets, bracket, clearIdle, onPick],
  );

  /** A swatch click is its own commit: one deliberate choice, one recent. */
  const commitPick = useCallback(
    (hex: string) => {
      applyLive(hex);
      flushCommit();
    },
    [applyLive, flushCommit],
  );

  const handleClear = useCallback(() => {
    // Gated like every other write: `onClear` used to call bracket() directly,
    // which is precisely the unguarded path a `history` prop on the picks alone
    // would have missed.
    if (brackets) bracket();
    onClear?.();
  }, [brackets, bracket, onClear]);

  const handleClearRecents = useCallback(() => {
    clearRecentColors();
    // Drop anything staged, or the flush on close would immediately re-add the
    // colour the user just asked to forget.
    stagerRef.current?.discard();
    clearIdle();
    setRecents([]);
  }, [clearIdle]);

  /* ── open / close lifecycle ──────────────────────────────────────────── */

  // Portal host, resolved at OPEN time in a LAYOUT effect (before paint, so the
  // popover never renders one frame into the wrong host).
  useLayoutEffect(() => {
    if (!open) {
      setHost(null);
      return;
    }
    const doc = document as FsDocument;
    const fsEl = (document.fullscreenElement ?? doc.webkitFullscreenElement ?? null) as
      | HTMLElement
      | null;
    setHost(pickPortalHost(fsEl, anchor, document.body));
    setRecents(getRecentColors());
  }, [open, anchor]);

  // Measure-and-clamp, the ContextMenu precedent: render, read the REAL rect in
  // a layout effect, place it before paint. Deps carry everything that changes
  // the popover's height — the palette set, the recents count, and whether the
  // reset entry is drawn.
  useLayoutEffect(() => {
    if (!open || !host) return;
    const el = popRef.current;
    const a = anchor?.getBoundingClientRect();
    if (!el || !a) return;
    const r = el.getBoundingClientRect();
    const next = placePopover(
      { left: a.left, top: a.top, bottom: a.bottom },
      { width: r.width, height: r.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    // Bail on an unchanged position: a fresh object literal always fails
    // Object.is, so re-measuring after an unrelated parent render would
    // otherwise cost one extra render every time.
    setPos((prev) => (prev.left === next.left && prev.top === next.top ? prev : next));
  }, [open, host, anchor, sections, recents.length, hasClear]);

  // Outside pointerdown + Escape. Capture phase so a click React Flow swallows
  // (pane pan start) still closes the popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (popRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      closeSelf();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // MUST NOT LEAK. ContextMenu.tsx carries a bubble-phase Escape handler
      // that closes the WHOLE settings menu and skips only INPUT / TEXTAREA /
      // SELECT / contentEditable — the popover's swatches are <button>, so once
      // a picker lives inside a context menu, escaping out of the popover would
      // take the menu with it. Stopping propagation in this capture-phase
      // listener is what keeps Escape meaning "close the popover".
      e.stopPropagation();
      closeSelf();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, closeSelf]);

  // A popover portalled into a fullscreen element must not outlive that
  // element: entering or leaving fullscreen tears the host down (or moves the
  // anchor), so close rather than leave the popover parented to nothing.
  useEffect(() => {
    if (!open) return;
    const onFsChange = () => closeSelf();
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, [open, closeSelf]);

  // Only one popover at a time (see closeOpenPicker).
  useEffect(() => {
    if (!open) return;
    if (closeOpenPicker && closeOpenPicker !== closeSelf) closeOpenPicker();
    closeOpenPicker = closeSelf;
    return () => {
      if (closeOpenPicker === closeSelf) closeOpenPicker = null;
    };
  }, [open, closeSelf]);

  // Closing — including unmounting while open (the node is deleted mid-pick) —
  // is a commit point: flush the staged colour and close the undo bracket, so
  // neither can be left dangling.
  useEffect(() => {
    if (!open) return;
    return () => {
      flushCommit();
      closeBracket();
    };
  }, [open, flushCommit, closeBracket]);

  if (!open || !host) return null;

  return createPortal(
    <div ref={popRef} className="palette-pop nodrag" style={{ left: pos.left, top: pos.top }}>
      {hasClear && (
        <button type="button" className="palette-pop__clear" onClick={handleClear}>
          <span
            className="palette-pop__clear-swatch"
            // The slash rides ON TOP of the site's default colour — inline
            // because a bare background would replace the class's gradient.
            style={
              clearColor
                ? {
                    background: `linear-gradient(to top right, transparent calc(50% - 1px), rgba(0, 0, 0, 0.45) calc(50% - 0.5px), rgba(0, 0, 0, 0.45) calc(50% + 0.5px), transparent calc(50% + 1px)), ${clearColor}`,
                  }
                : undefined
            }
          />
          {t('Default (none)', language)}
        </button>
      )}

      {sections.map((sec) => (
        <div key={sec.key} className="palette-pop__section">
          <div className="palette-pop__label" title={sec.name}>
            {sec.name}
          </div>
          <div className="palette-pop__row">
            {sec.colors.map((hex, i) => (
              <button
                // A palette is often a ramp, so duplicate colours are legal and
                // deliberate — the index is what keeps their keys distinct.
                key={`${hex}#${i}`}
                type="button"
                className={`palette-pop__swatch ${current === hex ? 'palette-pop__swatch--current' : ''}`}
                style={{ background: hex }}
                // `names` is materialized to the same length as `colors` by
                // buildPickerSections, so this index is always in range.
                title={swatchTitle(hex, sec.names[i])}
                onClick={() => commitPick(hex)}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Recents COLLAPSE when empty rather than drawing placeholder cells: a
          row of empty boxes is indistinguishable from a rendering bug, and the
          popover's height is measured rather than assumed, so a section that
          comes and goes costs nothing. */}
      {recents.length > 0 && (
        <div className="palette-pop__section">
          <div className="palette-pop__label palette-pop__label--recent">
            <span>{t('Recent', language)}</span>
            <button
              type="button"
              className="palette-pop__forget"
              title={t('Clear recent colors', language)}
              onClick={handleClearRecents}
            >
              ✕
            </button>
          </div>
          <div className="palette-pop__row">
            {recents.map((hex) => (
              <button
                key={hex}
                type="button"
                className={`palette-pop__swatch ${current === hex ? 'palette-pop__swatch--current' : ''}`}
                style={{ background: hex }}
                title={hex}
                onClick={() => commitPick(hex)}
              />
            ))}
          </div>
        </div>
      )}

      <label className="palette-pop__custom">
        <span>{t('Custom', language)}</span>
        {/* React maps this to the native `input` event with its own value
            tracker, so it fires per frame during a wheel drag AND on the
            dialog's own commit, deduped. It is therefore the LIVE path only —
            the recent colour is recorded by the idle/blur/close flush. */}
        <input
          type="color"
          value={value ?? '#ffffff'}
          onChange={(e) => applyLive(e.target.value)}
          onBlur={flushCommit}
        />
      </label>
    </div>,
    host,
  );
}

interface PaletteColorPickerProps extends ColorPickerCoreProps {
  className?: string;
  title?: string;
}

/**
 * The trigger swatch plus the popover above — the form most call sites want.
 *
 * The popover is a `position: fixed` portal (the AssetTooltip pattern), NOT a
 * child of whatever node hosts the trigger: a node-embedded popover would scale
 * with the canvas zoom and land under neighbouring nodes.
 */
export function PaletteColorPicker({
  value,
  onPick,
  onClear,
  clearColor,
  history,
  className = '',
  title,
}: PaletteColorPickerProps) {
  const language = useAppStore((s) => s.language);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`palette-swatch nodrag ${value ? '' : 'palette-swatch--unset'} ${className}`}
        style={value ? { background: value } : undefined}
        onClick={() => setOpen((o) => !o)}
        title={title ?? value ?? t('Pick a color', language)}
      />
      {/* btnRef is populated by the time `open` can flip (the flip is a click on
          that very button), so the popover always sees a real anchor. */}
      <ColorPickerPopover
        anchor={btnRef.current}
        open={open}
        onClose={close}
        value={value}
        onPick={onPick}
        onClear={onClear}
        clearColor={clearColor}
        history={history}
      />
    </>
  );
}

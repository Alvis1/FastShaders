import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { beginDragChrome } from '@/utils/dragChrome';
import { t } from '@/i18n';
import { RIGHT_SPLIT_MIN, useAppStore } from '@/store/useAppStore';
import { SeamLens, aimSeamLens, aimSeamLensAt } from './SeamLens';
import { assetBarDragHandle } from './assetBarDrag';
import type { SeamOrientation } from './seamLensGeometry';
import './SplitPane.css';

const clampRatio = (r: number) => Math.max(0.05, Math.min(0.95, r));

/**
 * Bounds for the preview/code split (the 3D preview is the TOP pane, `ratio`
 * is its share). Applied by the inner splitter to its own drag, and by the
 * outer splitter's junction drag to the same ratio — one clamp, two hands.
 *
 * The BOTTOM pane's floor is in PANE px rather than a ratio: the seam may ride
 * DOWN until only the code editor's TSL/A-Frame tab bar remains, and a ratio
 * floor would leave a screen-height-dependent stub of Monaco visible instead of
 * stopping AT the bar. ~37px measured bar (the 28px --ctl-size Apply/Import
 * buttons plus the actions row's 4px bottom padding, the 4px padding-top that
 * clears the seam, and the 1px border — see CodeEditor.css) and a small margin.
 *
 * The TOP pane takes a plain ratio floor instead — the 3D view has no collapsed
 * state worth stopping at, so it simply never drops below a quarter of the
 * column. That floor is the store's own `RIGHT_SPLIT_MIN`, read from there so
 * the persisted clamp and the drag's clamp cannot disagree.
 */
const CROSS_MIN_PANE_PX = 41;
export const clampPreviewSplit = (r: number, spanPx: number) =>
  Math.max(
    RIGHT_SPLIT_MIN,
    // A span short enough to make this cap fall BELOW the floor resolves to the
    // floor (Math.max wins) rather than inverting the bounds.
    Math.min(spanPx > 0 ? 1 - CROSS_MIN_PANE_PX / spanPx : 0.95, r),
  );

/**
 * JUNCTIONS: where another seam meets the column seam, a press drags BOTH.
 * There is no corner grip any more — the whole seam is the drag target — so a
 * junction is a place rather than a thing: the crossing itself, marked by the
 * lens turning into a ring, exactly where a window manager or VS Code's
 * sashes offer the same two-axis drag. The column seam has two:
 *
 *   'row' — the preview/code seam entering from the RIGHT (its height is
 *           `crossRatio` of this pane's span); the drag moves both ratios.
 *   'bar' — the asset bar's top edge entering from the LEFT (its height is
 *           whatever the bar is, read through the bar's registered handle);
 *           the drag moves this ratio and the bar's height.
 *
 * ZONE_PX is how close, along the seam, the pointer has to be. Small on
 * purpose: outside it the column seam moves only itself, which is what
 * "drag the edge" means everywhere else on the line. The column seam is
 * raised one z-index step (SplitPane.css) so it wins the hit test at both
 * crossings against the seams that run up to it.
 */
const JUNCTION_ZONE_PX = 12;
type JunctionKind = 'row' | 'bar';
interface Junction {
  kind: JunctionKind;
  /** The crossing's centre along this seam, px from the seam's start. */
  along: number;
}

/**
 * Touch axis lock for a junction drag. A touchscreen has no Shift key and a
 * finger drag always wobbles diagonally, so without a lock every preview-height
 * adjustment would drift the column split too (and both persist). The gesture's
 * first DECIDE_PX of travel picks an axis; a clearly diagonal pull (UNLOCK_PX
 * on the other axis) unlocks to free two-axis movement — deliberate diagonals
 * still work, wobble doesn't leak.
 */
const TOUCH_AXIS_DECIDE_PX = 8;
const TOUCH_AXIS_UNLOCK_PX = 24;

type DragAxis = 'free' | 'undecided' | 'x' | 'y';

/** Set imperatively for the life of a captured drag — `:hover` is browser
 *  state and this is ours, so the highlight and the lens cannot depend on how
 *  an engine reports hover while the pointer is captured. */
const DRAGGING_CLASS = 'fs-seam--dragging';
/** On the column seam while the pointer is on a junction (and for the life of
 *  a junction drag): `move` cursor and the ring in place of the bulge. The
 *  companion attribute names WHICH neighbour lights up with it. */
const CORNER_CLASS = 'fs-seam--xy';
const JUNCTION_ATTR = 'data-fs-junction';

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  direction?: 'horizontal' | 'vertical';
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /**
   * Bounds for `ratio`, given the pane span in px. Defaults to a generic
   * 5–95%; the preview/code splitter passes `clampPreviewSplit`.
   */
  clamp?: (ratio: number, spanPx: number) => number;
  /**
   * Second axis for a HORIZONTAL splitter: the ratio of the row split nested in
   * the right pane. When both are given this seam is the app's column seam and
   * grows its junctions (see JUNCTION_ZONE_PX). Requires the nested pane to
   * fill this pane's height, so the two ratios resolve against the same span.
   */
  crossRatio?: number;
  onCrossRatioChange?: (ratio: number) => void;
}

export function SplitPane({
  left,
  right,
  direction = 'horizontal',
  ratio,
  onRatioChange,
  clamp,
  crossRatio,
  onCrossRatioChange,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /** This gesture's dragChrome end call (idempotent; no-op before any drag). */
  const endDragChrome = useRef<() => void>(() => {});
  const language = useAppStore((s) => s.language);
  /**
   * Press-time snapshot for delta-based dragging: ratios move by how far the
   * pointer travelled from the press, never toward the pointer's absolute
   * position — so grabbing the seam off its centre-line doesn't snap it, and
   * the axis locks have a fixed origin to restore the locked axis to.
   */
  const dragStart = useRef({
    x: 0, y: 0, ratio: 0, cross: 0, axis: 'free' as DragAxis,
    /** The junction the press landed on, if any: this drag moves both. */
    junction: null as JunctionKind | null,
    /** Where the crossing was along the seam at press, so the ring can ride
     *  the drag without waiting for React to re-render the neighbour. */
    junctionAlong: 0,
    /** The asset bar's height at press — the base a 'bar' junction drags from. */
    barH: 0,
  });
  const isH = direction === 'horizontal';
  const orientation: SeamOrientation = isH ? 'v' : 'h';
  const twoAxis = isH && crossRatio != null && onCrossRatioChange != null;
  const clampOwn = clamp ?? clampRatio;

  /**
   * Which junction, if any, the pointer is on. The row seam's top edge is at
   * `crossRatio × span` (its pane is `height: ratio%`) and both seams share
   * one thickness token, so this divider's own width IS its thickness; the
   * bar's edge is asked for directly. The nearer wins if both are in range.
   */
  const junctionAt = useCallback((clientY: number): Junction | null => {
    if (!twoAxis || !containerRef.current || !dividerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const y = clientY - rect.top;
    const candidates: Junction[] = [
      { kind: 'row', along: crossRatio! * rect.height + dividerRef.current.offsetWidth / 2 },
    ];
    const edge = assetBarDragHandle()?.edgeY();
    if (edge != null && Number.isFinite(edge)) candidates.push({ kind: 'bar', along: edge - rect.top });
    let best: Junction | null = null;
    for (const c of candidates) {
      const d = Math.abs(y - c.along);
      if (d <= JUNCTION_ZONE_PX && (!best || d < Math.abs(y - best.along))) best = c;
    }
    return best;
  }, [twoAxis, crossRatio]);

  /** Mark (or clear) a junction on the seam element, and aim the lens: the
   *  ring snaps onto the crossing, the bulge follows the pointer. */
  const markJunction = useCallback((
    el: HTMLDivElement, j: Junction | null, clientX: number, clientY: number,
  ) => {
    el.classList.toggle(CORNER_CLASS, j != null);
    if (j) {
      el.setAttribute(JUNCTION_ATTR, j.kind);
      aimSeamLensAt(el, j.along);
    } else {
      el.removeAttribute(JUNCTION_ATTR);
      aimSeamLens(el, orientation, clientX, clientY);
    }
  }, [orientation]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Primary button only: a right-click press would otherwise start the drag
    // chrome and then the native context menu swallows the pointerup, leaving
    // the app-wide selection block and the resize cursor stranded on.
    if (e.button !== 0) return;
    // Stops the browser starting a text-selection drag from the press itself.
    e.preventDefault();
    const j = junctionAt(e.clientY);
    dragging.current = true;
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      ratio,
      cross: crossRatio ?? 0,
      // Touch junction drags start axis-locked (see the constants above);
      // everything else moves freely from the first pixel.
      axis: j && e.pointerType === 'touch' ? 'undecided' : 'free',
      junction: j?.kind ?? null,
      junctionAlong: j?.along ?? 0,
      barH: assetBarDragHandle()?.height() ?? 0,
    };
    const el = e.currentTarget;
    el.classList.add(DRAGGING_CLASS);
    markJunction(el, j, e.clientX, e.clientY);
    el.setPointerCapture(e.pointerId);
    endDragChrome.current = beginDragChrome(
      j ? 'move' : isH ? 'col-resize' : 'row-resize',
    );
  }, [isH, ratio, crossRatio, junctionAt, markJunction]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (!dragging.current) {
      // Plain hover: keep the mark and the lens under the pointer.
      markJunction(el, junctionAt(e.clientY), e.clientX, e.clientY);
      return;
    }
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const s = dragStart.current;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    // Touch axis lock: first movement picks the axis, a hard diagonal unlocks.
    // On unlock the freed axis is REBASED to the current pointer position, so
    // it continues smoothly from its held value instead of jumping by the
    // travel it accumulated while locked.
    if (s.axis === 'undecided') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= TOUCH_AXIS_DECIDE_PX) {
        s.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
    } else if (s.axis === 'x' && Math.abs(dy) >= TOUCH_AXIS_UNLOCK_PX) {
      s.axis = 'free';
      s.y = e.clientY;
    } else if (s.axis === 'y' && Math.abs(dx) >= TOUCH_AXIS_UNLOCK_PX) {
      s.axis = 'free';
      s.x = e.clientX;
    }
    // Shift (mouse/pen) locks a junction drag to the dominant axis, measured
    // from the PRESS point (drawing-app convention) — so pressing Shift
    // mid-gesture snaps the other axis back to where the drag began rather
    // than freezing it wherever the pointer happens to be.
    const both = s.junction != null;
    const shiftLockX = both && e.shiftKey && s.axis === 'free' && Math.abs(dx) >= Math.abs(dy);
    const shiftLockY = both && e.shiftKey && s.axis === 'free' && !shiftLockX;
    const holdX = s.axis === 'y' || shiftLockY;
    const holdY = s.axis === 'x' || shiftLockX;
    // The lens: the bulge follows the hand; the ring rides the CROSSING,
    // which moves by exactly the pointer's along-seam travel unless that axis
    // is held (the neighbour has not been re-rendered yet, so it is computed
    // rather than measured).
    const travel = holdY ? 0 : e.clientY - s.y;
    if (both) aimSeamLensAt(el, s.junctionAlong + travel);
    else aimSeamLens(el, orientation, e.clientX, e.clientY);
    const span = isH ? rect.width : rect.height;
    onRatioChange(clampOwn(
      (isH ? holdX : holdY)
        ? s.ratio
        : s.ratio + (isH ? (e.clientX - s.x) / rect.width : (e.clientY - s.y) / rect.height),
      span,
    ));
    if (s.junction === 'row') {
      // Same span for both axes: the nested pane fills this one's height (see
      // the crossRatio prop note), so its ratio resolves against rect.height.
      onCrossRatioChange!(clampPreviewSplit(s.cross + travel / rect.height, rect.height));
    } else if (s.junction === 'bar') {
      // The bar grows UPWARD, so pointer travel down is a shorter bar. Painted
      // imperatively through the bar's own handle; committed at pointerup.
      assetBarDragHandle()?.push(s.barH - travel);
    }
  }, [isH, orientation, clampOwn, onRatioChange, onCrossRatioChange, junctionAt, markJunction]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    // Restore document chrome FIRST: if releasePointerCapture throws (a pointer
    // the browser already released), the cursor override and the app-wide
    // selection block must not be stranded on.
    endDragChrome.current();
    // Bake in whatever height a 'bar' junction drag painted onto the asset
    // bar. Safe to call unconditionally — it is a no-op when nothing was
    // pushed, and it must run on pointercancel too or a cancelled drag leaves
    // the bar showing a height React does not know about.
    assetBarDragHandle()?.commit();
    const el = e.currentTarget;
    el.classList.remove(DRAGGING_CLASS);
    // The pointer may have been released anywhere — recompute the junction
    // from where it actually is, and drop it outright when it is no longer
    // over this seam at all (the boundary events that follow a capture
    // release also clear `:hover`, so the lens closes with it).
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const still = !!over && el.contains(over) ? junctionAt(e.clientY) : null;
    markJunction(el, still, e.clientX, e.clientY);
    el.releasePointerCapture(e.pointerId);
  }, [junctionAt, markJunction]);

  const handlePointerLeave = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (dragging.current) return;
    e.currentTarget.classList.remove(CORNER_CLASS);
    e.currentTarget.removeAttribute(JUNCTION_ATTR);
  }, []);

  /** Keyboard resize, so the layout isn't pointer-only. The column seam takes
      all four arrows — ←/→ move it, ↑/↓ the row seam it meets at the junction —
      and the row seam its own ↑/↓. */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = (e.shiftKey ? 0.1 : 0.02);
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
      : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : 0;
    if (dir === 0) return;
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const rect = containerRef.current?.getBoundingClientRect();
    if (twoAxis && vertical) {
      onCrossRatioChange!(clampPreviewSplit(crossRatio! + dir * step, rect?.height ?? 0));
    } else if (vertical === !isH) {
      onRatioChange(clampOwn(ratio + dir * step, (isH ? rect?.width : rect?.height) ?? 0));
    } else return;
    e.preventDefault();
  }, [isH, twoAxis, ratio, crossRatio, clampOwn, onRatioChange, onCrossRatioChange]);

  // Unmounting mid-drag would otherwise strand the cursor override and the
  // app-wide selection block with nothing left to clear them — and, if this
  // gesture was dragging the bar's junction, leave the bar at a height
  // painted imperatively that React was never told about.
  useEffect(() => () => {
    endDragChrome.current();
    assetBarDragHandle()?.commit();
  }, []);

  const firstSize = isH
    ? { width: `${ratio * 100}%` }
    : { height: `${ratio * 100}%` };

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: isH ? 'row' : 'column',
        flex: 1,
        overflow: 'hidden',
      }}
    >
      <div style={{ ...firstSize, overflow: 'hidden' }}>
        {left}
      </div>
      {/* The seam IS the control: the whole line drags (a widened hit zone
          and the hover lens come from `.fs-seam` in styles/controls.css), and
          it is the keyboard target too. isH (a horizontal split) draws a
          VERTICAL line, hence fs-seam--v. */}
      <div
        ref={dividerRef}
        className={`split-pane__divider split-pane__divider--${isH ? 'h' : 'v'} fs-seam fs-seam--${orientation}`}
        role="separator"
        aria-orientation={isH ? 'vertical' : 'horizontal'}
        title={t('Drag to resize the panels', language)}
        aria-label={t('Drag to resize the panels', language)}
        aria-valuenow={Math.round(ratio * 100)}
        // Announces BOTH ratios on the column seam, so ↑/↓ (which move
        // crossRatio, not aria-valuenow) still produce an audible change.
        aria-valuetext={twoAxis
          ? `${Math.round(ratio * 100)}% / ${Math.round(crossRatio * 100)}%`
          : undefined}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
      >
        <SeamLens orientation={orientation} />
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {right}
      </div>
    </div>
  );
}

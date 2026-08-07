import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { beginDragChrome } from '@/utils/dragChrome';
import { registerAssetBarHeightConsumer } from '@/utils/assetBarHeight';
import { t } from '@/i18n';
import { useAppStore } from '@/store/useAppStore';
import './SplitPane.css';

const clampRatio = (r: number) => Math.max(0.05, Math.min(0.95, r));

/**
 * Bounds for the cross axis (the preview/code split — the 3D preview is the TOP
 * pane, `ratio` is its share).
 *
 * The BOTTOM pane's floor is in PANE px rather than a ratio: the seam may ride
 * DOWN until only the code editor's TSL/Output tab bar remains, and a ratio
 * floor would leave a screen-height-dependent stub of Monaco visible instead of
 * stopping AT the bar. ~30px measured bar (25px of content plus the 4px
 * padding-top that clears the seam — see CodeEditor.css) and a small margin.
 *
 * The TOP pane takes a plain ratio floor instead — the 3D view has no collapsed
 * state worth stopping at, so it simply never drops below a quarter of the
 * column (the share it was guaranteed back when it was the bottom pane).
 *
 * The store's clamp mirrors both as a persistence safety net; these are the
 * bounds that actually stop the drag.
 */
const CROSS_MIN_PANE_PX = 34;
const CROSS_MIN_TOP_RATIO = 0.25;
const clampCross = (r: number, spanPx: number) =>
  Math.max(
    CROSS_MIN_TOP_RATIO,
    // A span short enough to make this cap fall BELOW the floor resolves to the
    // floor (Math.max wins) rather than inverting the bounds.
    Math.min(spanPx > 0 ? 1 - CROSS_MIN_PANE_PX / spanPx : 0.95, r),
  );

/**
 * Touch axis lock for the two-axis grip. A touchscreen has no Shift key and a
 * finger drag always wobbles diagonally, so without a lock every preview-height
 * adjustment would drift the column split too (and both persist). The gesture's
 * first DECIDE_PX of travel picks an axis; a clearly diagonal pull (UNLOCK_PX
 * on the other axis) unlocks to free two-axis movement — deliberate diagonals
 * still work, wobble doesn't leak.
 */
const TOUCH_AXIS_DECIDE_PX = 8;
const TOUCH_AXIS_UNLOCK_PX = 24;

type DragAxis = 'free' | 'undecided' | 'x' | 'y';

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  direction?: 'horizontal' | 'vertical';
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /**
   * Second axis for a HORIZONTAL splitter's grip: the ratio of the row split
   * nested in the right pane. When both are given, the grip anchors at that
   * height on the seam and dragging it moves BOTH splits — one corner control
   * for the whole layout. Requires the nested pane to fill this pane's height,
   * so the two ratios resolve against the same span.
   */
  crossRatio?: number;
  onCrossRatioChange?: (ratio: number) => void;
  /**
   * Render the drag grip. Pass false for a seam whose ratio is driven from
   * elsewhere (the code/preview split rides the corner grip above it) — the
   * divider stays visible but nothing on it is interactive.
   */
  grip?: boolean;
}

export function SplitPane({
  left,
  right,
  direction = 'horizontal',
  ratio,
  onRatioChange,
  crossRatio,
  onCrossRatioChange,
  grip = true,
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
   * position — so grabbing the grip off-centre doesn't snap the seam, and the
   * axis locks have a fixed origin to restore the locked axis to.
   */
  const dragStart = useRef({ x: 0, y: 0, ratio: 0, cross: 0, axis: 'free' as DragAxis });
  const isH = direction === 'horizontal';
  const twoAxis = isH && crossRatio != null && onCrossRatioChange != null;

  // currentTarget, not target: the grip's pseudo-element children are inside
  // it, so capture and release must land on the same element.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Primary button only: a right-click press would otherwise start the drag
    // chrome and then the native context menu swallows the pointerup, leaving
    // the app-wide selection block and the resize cursor stranded on.
    if (e.button !== 0) return;
    // Stops the browser starting a text-selection drag from the press itself.
    e.preventDefault();
    dragging.current = true;
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      ratio,
      cross: crossRatio ?? 0,
      // Touch gestures on the two-axis grip start axis-locked (see the
      // constants above); everything else moves freely from the first pixel.
      axis: twoAxis && e.pointerType === 'touch' ? 'undecided' : 'free',
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    endDragChrome.current = beginDragChrome(
      twoAxis ? 'move' : isH ? 'col-resize' : 'row-resize',
    );
  }, [isH, twoAxis, ratio, crossRatio]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
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
    // Shift (mouse/pen) locks to the dominant axis, measured from the PRESS
    // point (drawing-app convention) — so pressing Shift mid-gesture snaps the
    // other axis back to where the drag began rather than freezing it wherever
    // the pointer happens to be.
    const shiftLockX = twoAxis && e.shiftKey && s.axis === 'free' && Math.abs(dx) >= Math.abs(dy);
    const shiftLockY = twoAxis && e.shiftKey && s.axis === 'free' && !shiftLockX;
    const holdX = s.axis === 'y' || shiftLockY;
    const holdY = s.axis === 'x' || shiftLockX;
    onRatioChange(clampRatio(
      (isH ? holdX : holdY)
        ? s.ratio
        : s.ratio + (isH ? (e.clientX - s.x) / rect.width : (e.clientY - s.y) / rect.height),
    ));
    if (twoAxis) {
      // Same span for both axes: the nested pane fills this one's height (see
      // the crossRatio prop note), so its ratio resolves against rect.height.
      onCrossRatioChange!(clampCross(
        holdY ? s.cross : s.cross + (e.clientY - s.y) / rect.height,
        rect.height,
      ));
    }
  }, [isH, twoAxis, onRatioChange, onCrossRatioChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    // Restore document chrome FIRST: if releasePointerCapture throws (a pointer
    // the browser already released), the cursor override and the app-wide
    // selection block must not be stranded on.
    endDragChrome.current();
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  /** Keyboard resize, so the layout isn't pointer-only. A two-axis grip takes
      all four arrows: ←/→ move this seam, ↑/↓ the nested one. */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = (e.shiftKey ? 0.1 : 0.02);
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
      : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : 0;
    if (dir === 0) return;
    const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    if (twoAxis && vertical) {
      const span = containerRef.current?.getBoundingClientRect().height ?? 0;
      onCrossRatioChange!(clampCross(crossRatio! + dir * step, span));
    } else if (vertical === !isH) onRatioChange(clampRatio(ratio + dir * step));
    else return;
    e.preventDefault();
  }, [isH, twoAxis, ratio, crossRatio, onRatioChange, onCrossRatioChange]);

  // Unmounting mid-drag would otherwise strand the cursor override and the
  // app-wide selection block with nothing left to clear them.
  useEffect(() => () => endDragChrome.current(), []);

  /**
   * The corner grip's position clamps above the asset bar (the min() on
   * .fs-grip--v in controls.css), so a horizontal splitter's divider consumes
   * the bar's live height. Registered on this one element (rather than
   * inherited from :root) to keep the per-frame write during an asset-bar
   * drag down to one node.
   */
  useEffect(() => {
    const el = dividerRef.current;
    if (!el || !isH) return;
    return registerAssetBarHeightConsumer(el);
  }, [isH]);

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
      <div
        ref={dividerRef}
        className={`split-pane__divider split-pane__divider--${isH ? 'h' : 'v'}`}
        // Scoped to this one element rather than :root — the value changes every
        // frame of the grip's own drag, and an inherited custom property set
        // on the document element invalidates the computed style of everything
        // under it (React Flow's graph and a Monaco instance included).
        style={twoAxis
          ? ({ '--fs-grip-offset': `${crossRatio * 100}%` } as CSSProperties)
          : undefined}
      >
        {grip && (
          /* Shared resize grip (styles/controls.css) — the same tab the asset
             bar uses, and the ONLY drag target: the bar itself is inert, so a
             stray press on the seam can't nudge the layout.
             isH (a horizontal split) draws a VERTICAL bar, hence --v. */
          <div
            className={`fs-grip fs-grip--${isH ? 'v' : 'h'}${twoAxis ? ' fs-grip--xy' : ''}`}
            role="separator"
            // A two-axis grip has no single orientation, and claiming one would
            // misdescribe half its arrow keys — omit it and let aria-valuetext
            // below carry both numbers instead.
            aria-orientation={twoAxis ? undefined : isH ? 'vertical' : 'horizontal'}
            title={t('Drag to resize the panels', language)}
            aria-label={t('Drag to resize the panels', language)}
            aria-valuenow={Math.round(ratio * 100)}
            // Announces BOTH ratios, so ↑/↓ on the two-axis grip (which move
            // crossRatio, not aria-valuenow) still produce an audible change.
            aria-valuetext={twoAxis
              ? `${Math.round(ratio * 100)}% / ${Math.round(crossRatio * 100)}%`
              : undefined}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown}
          />
        )}
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {right}
      </div>
    </div>
  );
}

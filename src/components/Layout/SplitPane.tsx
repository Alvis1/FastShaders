import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { beginDragChrome } from '@/utils/dragChrome';
import { t } from '@/i18n';
import { useAppStore } from '@/store/useAppStore';
import './SplitPane.css';

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  direction?: 'horizontal' | 'vertical';
  ratio: number;
  onRatioChange: (ratio: number) => void;
  /**
   * Which end of the divider the grip sits 20% in from. Defaults to 'end'
   * (right/bottom); 'start' exists so the two horizontal grips in the app
   * (this seam and the asset bar's) don't land on the same side.
   */
  gripPosition?: 'start' | 'end';
}

export function SplitPane({
  left,
  right,
  direction = 'horizontal',
  ratio,
  onRatioChange,
  gripPosition = 'end',
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  /** This gesture's dragChrome end call (idempotent; no-op before any drag). */
  const endDragChrome = useRef<() => void>(() => {});
  const language = useAppStore((s) => s.language);
  /**
   * Pointer offset from the divider's centre at grab time. The grip hangs
   * BESIDE the seam (half a --ctl-size away), so without this the first
   * pointermove would snap the divider to the cursor — a visible jump of the
   * grip's own width.
   */
  const grabOffset = useRef(0);
  const isH = direction === 'horizontal';

  // currentTarget, not target: the grip is a hit-testable child, so a grab that
  // starts on IT would otherwise capture on the grip and release on the divider
  // — leaving the body cursor and userSelect overrides stuck on.
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Primary button only: a right-click press would otherwise start the drag
    // chrome and then the native context menu swallows the pointerup, leaving
    // the app-wide selection block and the resize cursor stranded on.
    if (e.button !== 0) return;
    // Stops the browser starting a text-selection drag from the press itself.
    e.preventDefault();
    dragging.current = true;
    const d = dividerRef.current?.getBoundingClientRect();
    grabOffset.current = d
      ? (isH ? e.clientX - (d.left + d.width / 2) : e.clientY - (d.top + d.height / 2))
      : 0;
    e.currentTarget.setPointerCapture(e.pointerId);
    endDragChrome.current = beginDragChrome(isH ? 'col-resize' : 'row-resize');
  }, [isH]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const newRatio = isH
      ? (e.clientX - grabOffset.current - rect.left) / rect.width
      : (e.clientY - grabOffset.current - rect.top) / rect.height;
    onRatioChange(Math.max(0.05, Math.min(0.95, newRatio)));
  }, [isH, onRatioChange]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragging.current = false;
    // Restore document chrome FIRST: if releasePointerCapture throws (a pointer
    // the browser already released), the cursor override and the app-wide
    // selection block must not be stranded on.
    endDragChrome.current();
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  /** Keyboard resize, so the layout isn't pointer-only. */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = (e.shiftKey ? 0.1 : 0.02);
    const back = isH ? 'ArrowLeft' : 'ArrowUp';
    const fwd = isH ? 'ArrowRight' : 'ArrowDown';
    let next: number;
    if (e.key === back) next = ratio - step;
    else if (e.key === fwd) next = ratio + step;
    else return;
    e.preventDefault();
    onRatioChange(Math.max(0.05, Math.min(0.95, next)));
  }, [isH, ratio, onRatioChange]);

  // Unmounting mid-drag would otherwise strand the cursor override and the
  // app-wide selection block with nothing left to clear them.
  useEffect(() => () => endDragChrome.current(), []);

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
      <div ref={dividerRef} className={`split-pane__divider split-pane__divider--${isH ? 'h' : 'v'}`}>
        {/* Shared resize grip (styles/controls.css) — the same tab the asset
            bar uses, and the ONLY drag target: the bar itself is inert, so a
            stray press on the seam can't nudge the layout.
            isH (a horizontal split) draws a VERTICAL bar, hence --v. */}
        <div
          className={`fs-grip fs-grip--${isH ? 'v' : 'h'}${gripPosition === 'start' ? ' fs-grip--start' : ''}`}
          role="separator"
          aria-orientation={isH ? 'vertical' : 'horizontal'}
          title={t('Drag to resize the panels', language)}
          aria-label={t('Drag to resize the panels', language)}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {right}
      </div>
    </div>
  );
}

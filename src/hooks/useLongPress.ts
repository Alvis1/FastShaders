import { useEffect, useRef } from 'react';

interface LongPressOptions {
  /** Hold duration before firing, ms. iOS native long-press is ~500ms. */
  delayMs?: number;
  /** Pixels of finger movement before the press is treated as a drag and cancelled. */
  moveTolerance?: number;
  /** When true, the listener is not installed. Useful for desktop-only opt-in. */
  disabled?: boolean;
}

/**
 * Fire `onLongPress` after a sustained touch / pen press on `targetRef`. Mouse
 * presses are ignored — right-click already covers desktop, and a hold-to-fire
 * gesture on the left button would conflict with selection and drag.
 *
 * The callback receives the *original event target* so the caller can dispatch
 * a synthesized event on it (e.g. `contextmenu` for React Flow's per-element
 * handlers, which key off the precise DOM target — pane vs node vs edge).
 */
export function useLongPress(
  targetRef: React.RefObject<HTMLElement | null>,
  onLongPress: (target: HTMLElement, clientX: number, clientY: number) => void,
  options: LongPressOptions = {},
): void {
  const { delayMs = 500, moveTolerance = 10, disabled = false } = options;
  const cbRef = useRef(onLongPress);
  cbRef.current = onLongPress;

  useEffect(() => {
    if (disabled) return;
    const el = targetRef.current;
    if (!el) return;

    let timerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startTarget: HTMLElement | null = null;
    let pointerId = -1;

    const cancel = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
      startTarget = null;
      pointerId = -1;
    };

    const onPointerDown = (e: PointerEvent) => {
      // Ignore mouse — right-click already covers it. Touch + pen only.
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      cancel();
      startX = e.clientX;
      startY = e.clientY;
      startTarget = e.target as HTMLElement;
      pointerId = e.pointerId;
      timerId = window.setTimeout(() => {
        timerId = null;
        if (startTarget) cbRef.current(startTarget, startX, startY);
      }, delayMs);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (pointerId !== e.pointerId || timerId === null) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy > moveTolerance * moveTolerance) cancel();
    };

    const onPointerEnd = (e: PointerEvent) => {
      if (pointerId !== e.pointerId) return;
      cancel();
    };

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerEnd);
    el.addEventListener('pointercancel', onPointerEnd);
    return () => {
      cancel();
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [targetRef, delayMs, moveTolerance, disabled]);
}

import { useEffect, useRef, type RefObject } from 'react';

/**
 * While open, close on a click outside every exempt ref or on Escape.
 * The handlers read the live `refs` array through a render-updated ref, so
 * callers may pass a fresh array literal each render without stale capture.
 * Shared by every toolbar popover (contact, Download app, VR, export
 * settings, work folder).
 */
export function useDismiss(
  open: boolean,
  setOpen: (open: boolean) => void,
  refs: RefObject<HTMLElement | null>[]
) {
  const refsRef = useRef(refs);
  refsRef.current = refs;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (refsRef.current.some((r) => r.current?.contains(t))) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // Capture phase: React Flow's d3 drag/zoom handlers stopImmediatePropagation
    // on node grabs and canvas pans, so a bubble listener never hears those
    // mousedowns and the popover would sit open over the canvas until an
    // empty-pane click. Capture runs document-first, before d3 can swallow it.
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, setOpen]);
}

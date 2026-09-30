import { useEffect, useRef } from 'react';

/**
 * A dialog's window `keydown` listener, bound while `active`. The handler is read
 * through a render-updated ref (as useDismiss does), so it never goes stale.
 * `capture` runs it before the canvas's window shortcuts, so it can swallow keys.
 */
export function useModalKeys(active: boolean, onKey: (e: KeyboardEvent) => void, capture = false): void {
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    if (!active) return;
    const listener = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener('keydown', listener, capture);
    return () => window.removeEventListener('keydown', listener, capture);
  }, [active, capture]);
}

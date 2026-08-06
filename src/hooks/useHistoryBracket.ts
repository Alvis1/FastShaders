import { useCallback, useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';

/**
 * How long a burst of change events may pause before the gesture is considered
 * over. Native color pickers fire an input event per frame while the swatch is
 * dragged; text fields fire one per keystroke — both well under this gap.
 */
const IDLE_MS = 600;

/**
 * History bracketing for continuous inputs with no pointerup to hook into —
 * native color pickers and text fields. `bracket()` on each change event opens
 * the store's coalescing bracket (one pre-gesture snapshot, further
 * pushHistory suppressed — see `beginInteraction`) and re-arms an idle timer;
 * the bracket closes on idle, on `closeBracket` (wire it to blur / the native
 * `change` commit), or on unmount. A picker drag or a typed rename then lands
 * as ONE undo entry instead of one full-graph structuredClone per event.
 *
 * The idle close is the safety net that guarantees the bracket can never be
 * left open (which would silently stop history recording for the session):
 * unlike DragNumberInput's pointer gesture there is no reliable "done" event
 * for a native picker dialog across browsers.
 */
export function useHistoryBracket(): { bracket: () => void; closeBracket: () => void } {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One begin/end pair per hook-open, so this hook's deferred close balances
  // exactly one beginInteraction. Overlapping gestures are safe at the STORE
  // level: begin/end are nesting-counted (`interactionDepth`), so our idle
  // timer firing mid-way through someone else's scrub only decrements the
  // count — it can never terminate a bracket another gesture still holds.
  const openedRef = useRef(false);

  const closeBracket = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (openedRef.current) {
      openedRef.current = false;
      useAppStore.getState().endInteraction();
    }
  }, []);

  const bracket = useCallback(() => {
    if (!openedRef.current) {
      useAppStore.getState().beginInteraction();
      openedRef.current = true;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(closeBracket, IDLE_MS);
  }, [closeBracket]);

  useEffect(() => closeBracket, [closeBracket]);
  return { bracket, closeBracket };
}

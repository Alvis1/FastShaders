import { useAppStore } from '@/store/useAppStore';

/**
 * Run `fn` as ONE undo entry, however many store actions it performs.
 *
 * The non-hook sibling of `useHistoryBracket`: that hook exists for BURSTS
 * with no reliable "done" event (a native colour picker, a typed field) and
 * therefore needs an idle timer; this is for a single composite ACT that
 * happens synchronously inside one event handler — a checkbox whose handler
 * touches the store two or three times.
 *
 * It exists because those compositions were recording an entry per store
 * action rather than per gesture, and the intermediate entries are states the
 * user never authored. Toggling an exposed parameter socket off is the worst
 * case: `toggleExposedPort` deletes the port's edges (one pushHistory) and is
 * evaluated BEFORE the `updateNodeData` that commits the new exposedPorts
 * (a second pushHistory), so the first Cmd+Z restored the socket while its
 * wire stayed deleted. Unticking Transparent with a wired Opacity was three.
 *
 * `beginInteraction`/`endInteraction` are nesting-counted (`interactionDepth`),
 * so nesting these — or firing one while a `useHistoryBracket` gesture is
 * still in its idle window — only rides the open bracket; it can never cut
 * another gesture short. The `finally` is load-bearing: a throw that skipped
 * `endInteraction` would leave `coalescingHistory` true and silently stop
 * history recording for the rest of the session.
 *
 * NB `beginInteraction` takes its snapshot AND clears `future` up front, so an
 * EMPTY body still costs an undo entry and destroys the redo stack — keep a
 * handler's early-return guards OUTSIDE the wrapper.
 */
export function asOneHistoryEntry<T>(fn: () => T): T {
  useAppStore.getState().beginInteraction();
  try {
    return fn();
  } finally {
    useAppStore.getState().endInteraction();
  }
}

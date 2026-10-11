/**
 * THE SETTLED PAIR AS REACT STATE, AND THE KEY THE PREVIEW DOCUMENT IS BUILT
 * UNDER: the React half of settledPreview.ts (which tells the race and holds
 * the watcher), kept out of ShaderPreview so a node test can mount these hooks
 * with the real renderer (settledPreview.test.ts).
 *
 * THE RULE: EVERY COLD REBUILD FIRST SETTLES WHAT THE MODULE IS DEBOUNCED ON.
 * ShaderPreview folds every input that needs a fresh document into
 * `coldInputsKey` and keys the document on what `useColdRebuildKey` returns
 * for it, never on the live string, so no cold input, today's or a future
 * one, can rebuild the document without first settling the module's two
 * debounced inputs: the {code, nodes} pair that a code change cut and React
 * does not hold yet (the debounce is still holding it back, or its timer has
 * committed it in an update a discrete event's render has jumped ahead of),
 * and the material settings' key (`useDebounced`). 2026-10-09: an edit, then
 * a Model switch or the WGSL/GLSL toggle within 200 ms, showed the previous
 * picture on the new document for up to ~100 ms; settledPreview.ts has the
 * measurements.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adoptSettled,
  settledPreviewOf,
  watchSettledPreview,
  type SettledPreview,
  type SettledPreviewWatch,
  type WatchSettledPreviewOptions,
} from './settledPreview';

export interface SettledPreviewState {
  /** The committed pair: the module the preview runs and the nodes it came from. */
  readonly settled: SettledPreview;
  /**
   * Make the state hold the watch's newest pair NOW (`SettledPreviewWatch.
   * latest`): the one the debounce still holds, or the one its timer
   * committed in an update React has not rendered yet. Never a live read of
   * the store. An ORDINARY state update, so never call it during render
   * (`useColdRebuildKey` says why); a no-op when the state already holds that
   * code. Stable identity.
   */
  readonly settlePending: () => void;
}

/**
 * The settled pair as state (trailing-debounced, and the first code after a
 * whole-graph replacement at once: `watchSettledPreview`), plus
 * `settlePending` for the cold rebuild. Every option must keep its identity
 * across renders (the store's own `getState`/`subscribe`, `window`): they are
 * the watch effect's deps.
 */
export function useSettledPreview({
  getState,
  subscribe,
  delayMs,
  events,
}: Omit<WatchSettledPreviewOptions, 'commit'>): SettledPreviewState {
  const [settled, setSettled] = useState(() => settledPreviewOf(getState()));
  // Written only by the effect; read by `settlePending`, which the cold
  // rebuild's microtask calls (`useColdRebuildKey`), never a render.
  const watchRef = useRef<SettledPreviewWatch | null>(null);
  useEffect(() => {
    const watch = watchSettledPreview({
      getState,
      subscribe,
      commit: (next) => setSettled((prev) => adoptSettled(prev, next)),
      delayMs,
      events,
    });
    watchRef.current = watch;
    return () => {
      watchRef.current = null;
      watch.dispose();
    };
  }, [getState, subscribe, delayMs, events]);
  const settlePending = useCallback(() => {
    // Read here, not inside the updater, so the updater stays a pure function
    // of `prev` (StrictMode calls updaters twice).
    const latest = watchRef.current?.latest();
    if (latest) setSettled((prev) => adoptSettled(prev, latest));
  }, []);
  return { settled, settlePending };
}

/**
 * Trailing-debounce a value: the first value is adopted immediately (so the
 * initial paint is not delayed) and each later change waits for `delayMs` of
 * quiet. `flush` adopts the newest RENDERED value now, for the cold rebuild:
 * an ordinary state update like `settlePending`, with a stable identity.
 * ShaderPreview's one use is the material settings' key, the module's second
 * debounced input.
 */
export function useDebounced<T>(value: T, delayMs: number): readonly [T, () => void] {
  const [settled, setSettled] = useState(value);
  // The newest value rendered, for `flush` (which runs after a commit).
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const id = setTimeout(() => setSettled(() => value), delayMs);
    return () => clearTimeout(id);
  }, [value, settled, delayMs]);
  const flush = useCallback(() => setSettled(() => valueRef.current), []);
  return [settled, flush] as const;
}

/**
 * The key the preview DOCUMENT is built under: `coldInputsKey`, adopted only
 * TOGETHER with `settle` (which commits both debounced inputs of the module:
 * the pending pair and the material settings' key) and only once every effect
 * of the commit that moved it has run, so every cold rebuild bakes the newest
 * code there is, a graph edit's own included.
 *
 * In the commit in which the inputs move nothing is rebuilt: the document memo,
 * keyed on the RETURNED key, keeps the previous document. A passive effect
 * queues a microtask, which runs after every effect of that commit, the sync
 * engine's graph->code pass among them, so a graph edit that itself moved a
 * cold key (a Raymarch Output starting to drive while a model is shown) has had
 * its code cut by then. The microtask settles and adopts with ORDINARY state
 * updates, batched into one render, in which the memo moves and bakes the
 * newest module once; the swap effect then finds the fresh document running
 * exactly that module and posts nothing. Cost: one extra commit before each
 * cold rebuild, in which no document changes, and a microtask.
 *
 * TRAP 1: key the memo on this hook's RESULT, never on `coldInputsKey`: a memo
 * keyed on the live key bakes in the render in which the inputs move, before
 * anything is settled. TRAP 2: never settle or adopt DURING RENDER, which the
 * first cut did (React's "adjust state while rendering" pattern). React does
 * not write a render-phase update to the hook's base state while a
 * lower-priority update is still queued on it, so rendering the watch timer's
 * skipped commit later rebased from the old base and DROPPED the settle: the
 * panel went back to an older module than the one baked, and the swap posted
 * it. A layout effect is no better for the graph edit: its code does not exist
 * until the passive effects run. TRAP 3: not in the passive effect itself
 * either: the graph->code pass is ANOTHER component's passive effect, and the
 * two run in tree order, which only the microtask makes irrelevant.
 * settledPreview.test.ts mounts each of these with the real renderer. TRAP 4:
 * in the commit in which the inputs move the OUTGOING document is still
 * attached (a task longer when the move is not a discrete event), so whatever
 * is keyed on the LIVE inputs still talks to it; what must follow the
 * document is keyed on the document (ShaderPreview's playhead reset).
 *
 * Returns the adopted key and whether a moved one is still `pending`, for
 * `holdsDocument`.
 */
export function useColdRebuildKey(coldInputsKey: string, settle: () => void): readonly [key: string, pending: boolean] {
  const [builtKey, setBuiltKey] = useState(coldInputsKey);
  useEffect(() => {
    if (builtKey === coldInputsKey) return;
    let superseded = false;
    queueMicrotask(() => {
      if (superseded) return;
      settle();
      setBuiltKey(coldInputsKey);
    });
    // A newer move, or the unmount, before the microtask: it adopts nothing.
    return () => { superseded = true; };
  }, [builtKey, coldInputsKey, settle]);
  return [builtKey, builtKey !== coldInputsKey] as const;
}

/**
 * Whether the preview holds its document back (the iframe's `srcDoc`, and the
 * rebuild and swap effects that would feed it): while the boot hold reads a
 * cached mesh (bootMeshWait.ts), and, until a FIRST document is attached,
 * while a cold rebuild is pending. The cached mesh landing lifts the boot hold
 * in the very render in which it moves the cold key, and the memo still holds
 * the sphere bake then (`useColdRebuildKey` adopts after the commit's effects),
 * so that render would attach the sphere document only to replace it a moment
 * later: the throwaway load the boot hold exists to spare. Once a document is
 * up, a pending rebuild keeps it on screen instead.
 */
export function holdsDocument(bootMeshHeld: boolean, coldRebuildPending: boolean, attached: boolean): boolean {
  return bootMeshHeld || (coldRebuildPending && !attached);
}

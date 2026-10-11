import { useEffect, type DependencyList, type RefObject } from 'react';
import { subscribeFrames, type FrameLoopOptions, type FrameTick } from '@/utils/frameTicker';

/**
 * Put a decorative canvas surface on the shared 15 Hz frame ticker
 * (utils/frameTicker) while `enabled`.
 *
 * `makeTick` is a FACTORY, called inside the effect on every (re)start, so the
 * per-run closure state it keeps (the last string written, the last phase
 * drawn) starts fresh whenever `deps` change. The tick it returns must read
 * the graph with `useAppStore.getState()` on each call — a mirror ref of a
 * subscription would freeze the surface on the graph it started with.
 *
 * `elRef` names the element whose visibility gates the tick: off-screen or
 * `display: none` (a collapsed group's member) skips it, calling
 * `opts.onHidden` instead. It is read once per start, so it must be an element
 * that lives as long as the component. `opts` is captured with the start, and
 * `opts.onStop` receives that same element when the loop stops (unmount,
 * `enabled` turning false, or a deps change).
 *
 * The effect's deps are `[enabled, ...deps]`; keep each call site's `deps`
 * list the same length on every render.
 */
export function useFrameLoop<E extends Element>(
  enabled: boolean,
  elRef: RefObject<E> | null,
  makeTick: () => FrameTick,
  deps: DependencyList,
  opts?: FrameLoopOptions<E>,
): void {
  useEffect(() => {
    if (!enabled) return;
    return subscribeFrames(elRef?.current ?? null, makeTick(), opts);
    // The factory, ref and options are captured per start; `deps` is the
    // restart signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
}

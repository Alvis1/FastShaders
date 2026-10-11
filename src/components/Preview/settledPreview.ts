/**
 * WHAT THE PREVIEW RUNS, SETTLED: the module's code AND the nodes it was
 * generated from, as ONE value.
 *
 * A LEAF (one type-only import), so the rule is node-testable: ShaderPreview is
 * a large .tsx with an iframe, postMessage and localStorage in it and has never
 * been rendered in a test (bootMeshWait.ts says the same). Its React half, the
 * hooks ShaderPreview calls, is useSettledPreview.ts, small enough for a test
 * to mount with the real renderer.
 *
 * THE BUG IT FIXES (2026-10-08, measured in real Chrome on an isolated
 * worktree). ShaderPreview bakes and posts a 200 ms-DEBOUNCED module, but it
 * planned which `fs-asset:` payloads that module may resolve from the LIVE
 * store nodes. A placeholder key is `<node id>-<payload hash>`, so the keys a
 * module names exist only on the nodes it was generated from, and the live
 * nodes run ahead of a debounced module. "Mesh with Materials" changes a COLD
 * key (the model) and replaces the graph in the same tick, so the document
 * memo rebuilt in that render with the PREVIOUS import's module while the live
 * nodes held only the new key: the boot list came out EMPTY, the document ran
 * `img.src = "fs-asset:…"`, Chrome logged `net::ERR_UNKNOWN_URL_SCHEME`,
 * `decode()` rejected, and the new model was drawn with the 1x1 black fallback
 * for ~100 ms (six frames of a solid black quad in a CDP screencast) until the
 * debounce settled and the hot swap put the right picture up. Reproduced the
 * same way by NEW or Open while a model is shown, Open of a .zip carrying a
 * model, a splat's "Clear graph", two quick imports, and any cold key (the
 * Model dropdown across the model boundary, the WGSL/GLSL toggle, the ack
 * watchdog's `coldGen`) inside 200 ms of a payload change (Revert, Resolution,
 * From file…). The comment that defended the live read ("the placeholder
 * embeds a payload hash, so swapping an image always changes the code") was
 * true and beside the point: it proves the code moves when an image does,
 * never that the code has caught up with the nodes.
 *
 * THE RULE (fix A). The settled value is `{ code, nodes }`, cut from ONE store
 * notification (the one that moved `previewCode`) and committed whole, so the
 * module and the nodes its keys live on always come from the same render.
 * Every asset plan (the document memo's boot list, every `postShaderSwap`) is
 * made from those nodes, never from `useAppStore.getState().nodes`. Nothing
 * else moves: no new selector (the pair is cut inside the existing store
 * SUBSCRIPTION, so a drag frame still re-renders nothing), no module-text
 * change, nothing new crosses the sandbox. Cost: one older `nodes` array stays
 * referenced until the next settle.
 *
 * THE FLUSH (fix B). With A alone, a cold rebuild inside the debounce bakes the
 * previous module CORRECTLY: the previous picture on the new model for about
 * four frames, a stale picture that looks right. A whole-graph replacement
 * (`GRAPH_REPLACED_EVENTS`) has no scrub to wait out, so the NEXT code change
 * after one settles at once instead of after the debounce. The flag lapses
 * after `GRAPH_REPLACED_FLUSH_MS`, so a replacement whose code never moves
 * cannot leave it set. At first the fresh document received the new module
 * through the load-time replay (`handleIframeLoad` posts it BEFORE the model),
 * so the new model's first shaded frame already ran it; since the cold key is
 * adopted after the commit's effects (below) the rebuilt document BAKES it.
 * Measured with A and B across twelve browser scenarios: zero
 * ERR_UNKNOWN_URL_SCHEME, zero black-fallback frames, the new picture on the
 * first shaded frame after every replacement, and one shader compile instead
 * of two.
 *
 * EVERY COLD REBUILD SETTLES FIRST (fix D, 2026-10-09). A and B still left a
 * cold key that is NOT a replacement: the Model dropdown across the model
 * boundary, the WGSL/GLSL toggle or the ack watchdog's `coldGen`, moving
 * inside the debounce of an edit, rebuilt the document with the PREVIOUS
 * settled module, resolved, so the previous picture stood on the new document
 * until the swap landed. Measured in real Chrome: a payload change and then
 * GLB -> Sphere showed the old picture for 3-6 rAF frames (~100 ms) in 5 of 5
 * runs; the backend toggle, 2 frames in 1 of 11. So the watch exposes
 * `latest()`, the newest pair it has cut: the one its debounce still holds, or
 * the one its timer just committed, which React may not have rendered yet (a
 * discrete event's render, the dropdown's change or the toggle's click, runs
 * AHEAD of the timer's default-priority update). `useColdRebuildKey`
 * (useSettledPreview.ts) commits it before it adopts the moved key the
 * document memo is keyed on. It is the pair the timer commits (one store
 * notification's code and nodes, never a live read), so the timer's own
 * commit of it is a no-op through `adoptSettled`. A scrub still never rebuilds
 * the document: the code is not a cold key, so only a cold key's own move
 * reaches the latest pair. After the fix, on the same harness, the rebuilt
 * document's first apply is the edit's own picture in 5 of 5 runs of each,
 * and a real pointer scrub still builds no document.
 *
 * ADOPTED AFTER THE COMMIT'S EFFECTS (2026-10-09, review). Fix D first settled
 * and adopted DURING the render in which the key moved, which left two holes,
 * both mounted with the real renderer in settledPreview.test.ts. A
 * render-phase update is not written to the hook's base state while a
 * lower-priority update is still queued on it, so when React later rendered
 * the timer's skipped commit it rebased from the old base and dropped the
 * settle: the panel went back to an OLDER module than the one just baked, and
 * the swap posted it to the fresh document. And a graph edit that itself
 * moves a cold key (a Raymarch Output starting or stopping to drive while a
 * model is shown) has no code in that render: the sync engine's graph->code
 * pass is a passive effect of the same commit, so the PRE-edit module was
 * baked. The key is now adopted in a microtask queued from a passive effect,
 * after every effect of that commit has run, with ordinary state updates that
 * a rebase replays, and the material settings' own debounce is settled with
 * the pair. Until a first document is attached, a pending adoption holds the
 * document back too (`holdsDocument`), so a boot with a cached model still
 * builds ONE document.
 *
 * NOT DONE, on purpose. The document's resolver still leaves an unknown key
 * verbatim: blanking one would only hide a planning error, and the `decode()`
 * fallback stays the documented degrade path for a key that is truly unknown.
 */
import type { AppNode } from '@/types';

/**
 * The module's source text and the nodes it was generated from: the asset
 * feed's ONE source. The nodes are for ASSET PLANNING ONLY, where the code alone
 * decides which keys are needed. Anything else the module reads from node data
 * keeps its own dep in ShaderPreview, never these nodes, because `adoptSettled`
 * keeps an older array whenever the code did not move: the mirror plan a live
 * key, the material settings a DEBOUNCED key of their own, which a cold rebuild
 * settles together with this pair (useSettledPreview.ts).
 */
export interface SettledPreview {
  readonly code: string;
  readonly nodes: AppNode[];
}

/** The store fields a settled value is cut from (the zustand state satisfies it structurally). */
export interface PreviewSource {
  readonly previewCode: string;
  readonly nodes: AppNode[];
}

/** The ONE spelling of the pair: the code and the nodes of the same store state. */
export function settledPreviewOf(s: PreviewSource): SettledPreview {
  return { code: s.previewCode, nodes: s.nodes };
}

/**
 * The value a settle commits. Unchanged code keeps the PREVIOUS pair, so React
 * bails on the identical object exactly as it bailed on the identical string
 * before the pair existed; that pair's nodes still hold every key the code
 * names. Otherwise the new pair, whole, never a mix of the two.
 */
export function adoptSettled(prev: SettledPreview, next: SettledPreview): SettledPreview {
  return prev.code === next.code ? prev : next;
}

/**
 * The window events that announce the graph was REPLACED: `fs:graph-imported`
 * (Open, through `applyProjectToStore` or the bare-script import, and the boot
 * seed), `fs:graph-merged` (`GRAPH_MERGED_EVENT`: Mesh with Materials and a
 * splat's Clear graph, and Add, whose parked group settling at once costs
 * nothing) and `fs:graph-new` (NEW). Each is dispatched before the new graph's
 * code reaches `previewCode`, which is what lets the flag catch that code. NOT
 * `fs:project-imported`, which also fires for a model-only zip.
 * settledPreview.test.ts pins the list against every dispatch site.
 */
export const GRAPH_REPLACED_EVENTS = ['fs:graph-imported', 'fs:graph-merged', 'fs:graph-new'] as const;

/**
 * How long a replacement keeps "settle the next code at once" armed. The code
 * follows the event within one sync-engine pass; the lapse only bounds a
 * replacement whose code never moves, so a later scrub is debounced as usual.
 */
export const GRAPH_REPLACED_FLUSH_MS = 1000;

export interface WatchSettledPreviewOptions {
  /** Read once per notification (`useAppStore.getState`). */
  getState: () => PreviewSource;
  /** `useAppStore.subscribe`: the listener runs on EVERY store notification. */
  subscribe: (listener: () => void) => () => void;
  /** Receives each settled pair: after `delayMs` of quiet, or at once after a replacement. */
  commit: (next: SettledPreview) => void;
  delayMs: number;
  /** Where `GRAPH_REPLACED_EVENTS` are dispatched (`window`). */
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

/** A running watch: the newest pair it has cut, and how to stop it. */
export interface SettledPreviewWatch {
  /**
   * The newest pair this watch has cut: the one its debounce still holds, or
   * the one it last committed, which React may not have RENDERED yet (a
   * discrete event's render skips the timer's lower-priority update, so "the
   * timer fired" does not mean "React holds it"). Null only after `dispose`.
   * A pure READ: it neither commits nor cancels anything, so asking twice is
   * harmless. The cold rebuild's settle (useSettledPreview.ts) is its one
   * caller, after the commit that moved the cold key, never during a render.
   */
  readonly latest: () => SettledPreview | null;
  /** Unsubscribe, remove the listeners and drop every timer. */
  readonly dispose: () => void;
}

/**
 * Trailing-debounce `previewCode` TOGETHER with its nodes, and settle the first
 * code after a whole-graph replacement at once.
 */
export function watchSettledPreview({
  getState,
  subscribe,
  commit,
  delayMs,
  events,
}: WatchSettledPreviewOptions): SettledPreviewWatch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The newest pair cut: what `timer` will commit, or what was last committed.
  // Null until the first call, which therefore always arms: it covers a change
  // that landed between the first render and this subscription.
  let latest: SettledPreview | null = null;
  // Set while a replacement's code is awaited (the NEXT code settles at once),
  // and it is the lapse that clears it.
  let flushLapse: ReturnType<typeof setTimeout> | undefined;

  const endFlush = () => {
    clearTimeout(flushLapse);
    flushLapse = undefined;
  };
  const onGraphReplaced = () => {
    endFlush();
    flushLapse = setTimeout(endFlush, GRAPH_REPLACED_FLUSH_MS);
  };
  const arm = () => {
    const s = getState();
    if (s.previewCode === latest?.code) return;
    // Cut HERE, in the notification that moved the code: these are the nodes
    // the code was generated from. Nodes read when the timer fires may already
    // belong to the next graph, which is the bug this module exists for.
    const next = settledPreviewOf(s);
    latest = next;
    clearTimeout(timer);
    timer = undefined;
    if (flushLapse !== undefined) {
      endFlush();
      commit(next);
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      commit(next);
    }, delayMs);
  };

  for (const type of GRAPH_REPLACED_EVENTS) events.addEventListener(type, onGraphReplaced);
  arm();
  const unsubscribe = subscribe(arm);
  return {
    latest: () => latest,
    dispose: () => {
      unsubscribe();
      clearTimeout(timer);
      timer = undefined;
      latest = null;
      endFlush();
      for (const type of GRAPH_REPLACED_EVENTS) events.removeEventListener(type, onGraphReplaced);
    },
  };
}

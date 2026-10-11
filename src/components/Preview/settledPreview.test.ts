/**
 * THE SETTLED PAIR: the debounced preview module and the nodes it was generated
 * from settle as ONE value, and the first code after a whole-graph replacement
 * settles at once. The race this closes (2026-10-08: ERR_UNKNOWN_URL_SCHEME and
 * ~100 ms of the 1x1 black fallback on a freshly imported model) is told in
 * settledPreview.ts.
 *
 * Four parts. The watcher, driven with fake timers, a stand-in store and a
 * real EventTarget (nothing stubbed on the global), its `latest()` included.
 * The race end to end: real graphToCode modules and the real asset planner,
 * then the preview DOCUMENT's own boot scripts (the baked boot list, the asset
 * resolver, the module-blob mint, cut out of tslToPreviewHTML's output)
 * EXECUTED against node's Blob, URL and atob, the previewAssetFeed.test.ts
 * technique, so "no placeholder reaches `img.src`" is read off the very text
 * the document would import. The cold rebuild (fix D and its review,
 * 2026-10-09): the hooks of useSettledPreview.ts MOUNTED with react-dom/client,
 * StrictMode included, since what makes it right is React's update, rebase and
 * effect-order semantics, and nothing short of the real renderer shows them;
 * each rejected shape is mounted beside it, failing its own scenario (`window`
 * and `IS_REACT_ACT_ENVIRONMENT` are stubbed for that block and restored). And
 * drift guards: the event list against every dispatch site in the app.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Fragment,
  StrictMode,
  act,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { makeNode, makeEdge } from '../../test-utils';
import { projectDocs } from '../../projectDocs';
import type { AppNode } from '@/types';
import { graphToCode } from '@/engine/graphToCode';
import { IMAGE_ASSET_PREFIX, collectImageAssets } from '@/engine/imageAssets';
import { PREVIEW_ASSETS_MESSAGE, PREVIEW_ASSET_RESOLVER_SCRIPT, planPreviewAssetFeed } from '@/engine/previewAssetFeed';
import { buildPreviewShaderModule, tslToPreviewHTML } from '@/engine/tslToPreviewHTML';
import {
  GRAPH_REPLACED_EVENTS,
  GRAPH_REPLACED_FLUSH_MS,
  adoptSettled,
  settledPreviewOf,
  watchSettledPreview,
  type PreviewSource,
  type SettledPreview,
} from './settledPreview';
import { holdsDocument, useColdRebuildKey, useDebounced, useSettledPreview } from './useSettledPreview';

/** ShaderPreview's PREVIEW_REBUILD_DEBOUNCE_MS (any value works; this is the shipped one). */
const DELAY = 200;

const graph = (tag: string): AppNode[] => [makeNode(`${tag}-out`, 'output')];

/** A zustand-shaped stand-in: a NEW state object per write, every listener told on every write. */
function fakeStore<S extends PreviewSource>(initial: S) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    set(patch: Partial<S>) {
      state = { ...state, ...patch };
      for (const fn of [...listeners]) fn();
    },
    listenerCount: () => listeners.size,
  };
}

/** The watcher as ShaderPreview's hook runs it, with every commit recorded. */
function watch(initial: PreviewSource) {
  const store = fakeStore(initial);
  const events = new EventTarget();
  const commits: SettledPreview[] = [];
  const { latest, dispose } = watchSettledPreview({
    getState: store.getState,
    subscribe: store.subscribe,
    commit: (next) => { commits.push(next); },
    delayMs: DELAY,
    events,
  });
  /** Let the mount arm settle, and forget it, so a test starts from rest. */
  const atRest = () => {
    vi.advanceTimersByTime(DELAY);
    commits.length = 0;
  };
  const replaced = (type: string = 'fs:graph-merged') => events.dispatchEvent(new Event(type));
  return { store, events, commits, latest, dispose, atRest, replaced };
}

describe('watchSettledPreview: the code and its nodes settle as ONE value', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('cuts the pair in the notification that moved the code, never at the settle', () => {
    const n0 = graph('n0');
    const n1 = graph('n1');
    const n2 = graph('n2');
    const w = watch({ previewCode: 'A', nodes: n0 });
    w.atRest();
    w.store.set({ previewCode: 'B', nodes: n1 });
    // The store runs ahead of the debounce: a drag frame, or the NEXT graph
    // (an import replacing it). The pending settle must keep B's own nodes.
    w.store.set({ nodes: n2 });
    vi.advanceTimersByTime(DELAY);
    expect(w.commits).toHaveLength(1);
    expect(w.commits[0].code).toBe('B');
    expect(w.commits[0].nodes).toBe(n1);
    w.dispose();
  });

  it('the first call always arms: it covers a change between the first render and the subscription', () => {
    const n0 = graph('n0');
    const w = watch({ previewCode: 'A', nodes: n0 });
    vi.advanceTimersByTime(DELAY - 1);
    expect(w.commits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.commits).toEqual([{ code: 'A', nodes: n0 }]);
    w.dispose();
  });

  it('a notification that does not move the code neither re-arms nor commits', () => {
    const w = watch({ previewCode: 'A', nodes: graph('n0') });
    w.atRest();
    for (let i = 0; i < 50; i++) w.store.set({ nodes: graph(`drag${i}`) });
    vi.advanceTimersByTime(10 * DELAY);
    expect(w.commits).toEqual([]);
    w.dispose();
  });

  it('a scrub settles ONCE, DELAY after its last move, with the last pair', () => {
    const w = watch({ previewCode: 'A', nodes: graph('n0') });
    w.atRest();
    const last = graph('s9');
    for (let i = 0; i < 10; i++) {
      w.store.set({ previewCode: `S${i}`, nodes: i === 9 ? last : graph(`s${i}`) });
      vi.advanceTimersByTime(DELAY / 2);
    }
    expect(w.commits).toEqual([]);
    vi.advanceTimersByTime(DELAY / 2);
    expect(w.commits).toEqual([{ code: 'S9', nodes: last }]);
    w.dispose();
  });
});

describe('watchSettledPreview: a whole-graph replacement settles at once', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('each replacement event settles the NEXT code synchronously, with its own nodes', () => {
    for (const type of GRAPH_REPLACED_EVENTS) {
      const fresh = graph(`fresh-${type}`);
      const w = watch({ previewCode: 'old', nodes: graph('old') });
      w.atRest();
      // The import writes the graph and announces it; its code does not exist
      // yet (the sync engine writes it in an effect), so nothing settles here.
      w.store.set({ nodes: fresh });
      w.replaced(type);
      expect(w.commits, type).toEqual([]);
      w.store.set({ previewCode: 'new' });
      // No timer advanced: the settle happened inside the store notification.
      expect(w.commits, type).toEqual([{ code: 'new', nodes: fresh }]);
      w.dispose();
    }
  });

  it('only the NEXT change: the one after it is debounced again', () => {
    const w = watch({ previewCode: 'old', nodes: graph('old') });
    w.atRest();
    w.replaced();
    w.store.set({ previewCode: 'new', nodes: graph('new') });
    expect(w.commits).toHaveLength(1);
    w.store.set({ previewCode: 'scrub', nodes: graph('scrub') });
    expect(w.commits).toHaveLength(1);
    vi.advanceTimersByTime(DELAY);
    expect(w.commits.map((c) => c.code)).toEqual(['new', 'scrub']);
    w.dispose();
  });

  it('drops a pending settle of an older pair: it is never committed late, over the new graph', () => {
    const w = watch({ previewCode: 'old', nodes: graph('old') });
    w.atRest();
    // An edit (a payload Revert, say) is still inside its debounce…
    w.store.set({ previewCode: 'edit', nodes: graph('edit') });
    vi.advanceTimersByTime(DELAY / 4);
    // …when Mesh with Materials replaces the graph.
    const fresh = graph('fresh');
    w.store.set({ nodes: fresh });
    w.replaced();
    w.store.set({ previewCode: 'new' });
    vi.advanceTimersByTime(5 * DELAY);
    expect(w.commits).toEqual([{ code: 'new', nodes: fresh }]);
    w.dispose();
  });

  it('the flag lapses after GRAPH_REPLACED_FLUSH_MS, so a replacement whose code never moved cannot leave it set', () => {
    const w = watch({ previewCode: 'same', nodes: graph('a') });
    w.atRest();
    w.replaced();
    w.store.set({ nodes: graph('b') }); // identical code: nothing to settle
    vi.advanceTimersByTime(GRAPH_REPLACED_FLUSH_MS);
    w.store.set({ previewCode: 'later scrub', nodes: graph('c') });
    expect(w.commits).toEqual([]);
    vi.advanceTimersByTime(DELAY);
    expect(w.commits.map((c) => c.code)).toEqual(['later scrub']);
    w.dispose();
  });

  it('still armed just inside the window, and a second replacement re-arms it from its own event', () => {
    const w = watch({ previewCode: 'old', nodes: graph('old') });
    w.atRest();
    w.replaced();
    vi.advanceTimersByTime(GRAPH_REPLACED_FLUSH_MS - 1);
    w.store.set({ previewCode: 'first' });
    expect(w.commits.map((c) => c.code)).toEqual(['first']);

    w.replaced();
    vi.advanceTimersByTime(GRAPH_REPLACED_FLUSH_MS * 0.9);
    w.replaced();
    vi.advanceTimersByTime(GRAPH_REPLACED_FLUSH_MS * 0.9);
    w.store.set({ previewCode: 'second' });
    expect(w.commits.map((c) => c.code)).toEqual(['first', 'second']);
    w.dispose();
  });

  it('other window events do not flush (fs:project-imported also fires for a model-only zip)', () => {
    const w = watch({ previewCode: 'old', nodes: graph('old') });
    w.atRest();
    for (const type of ['fs:project-imported', 'fs:uniform-authored', 'fs:graph-imported-not']) w.replaced(type);
    w.store.set({ previewCode: 'edit' });
    expect(w.commits).toEqual([]);
    vi.advanceTimersByTime(DELAY);
    expect(w.commits.map((c) => c.code)).toEqual(['edit']);
    w.dispose();
  });

  it('dispose unsubscribes, removes the listeners and drops every timer', () => {
    const w = watch({ previewCode: 'old', nodes: graph('old') });
    w.store.set({ previewCode: 'pending' });
    w.replaced(); // arms the lapse timer too
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    w.dispose();
    expect(w.store.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(w.latest()).toBeNull();
    vi.advanceTimersByTime(10 * DELAY);
    w.replaced();
    w.store.set({ previewCode: 'after dispose' });
    vi.advanceTimersByTime(10 * DELAY);
    expect(w.commits).toEqual([]);
  });
});

describe('watchSettledPreview: latest(), the pair a cold rebuild settles', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is the newest pair cut: held by the debounce, then the very object the timer commits', () => {
    const w = watch({ previewCode: 'A', nodes: graph('n0') });
    w.atRest();
    expect(w.latest()?.code).toBe('A');
    const n1 = graph('n1');
    w.store.set({ previewCode: 'B', nodes: n1 });
    // The store runs ahead (a drag frame, the next graph): the cut pair keeps B's own nodes.
    w.store.set({ nodes: graph('n2') });
    const cut = w.latest();
    expect(cut).toEqual({ code: 'B', nodes: n1 });
    expect(cut!.nodes).toBe(n1);
    vi.advanceTimersByTime(DELAY - 1);
    expect(w.latest()).toBe(cut);
    expect(w.commits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(w.commits).toEqual([cut]);
    expect(w.commits[0]).toBe(cut);
    // Still the newest after the commit: React may not have RENDERED that
    // commit yet, and the cold rebuild must not fall back to an older pair.
    expect(w.latest()).toBe(cut);
    w.dispose();
  });

  it('a newer code change replaces it (never an older pair), and a no-op notification leaves it alone', () => {
    const w = watch({ previewCode: 'A', nodes: graph('n0') });
    w.atRest();
    w.store.set({ previewCode: 'S1', nodes: graph('s1') });
    const s2 = graph('s2');
    w.store.set({ previewCode: 'S2', nodes: s2 });
    expect(w.latest()).toEqual({ code: 'S2', nodes: s2 });
    const before = w.latest();
    w.store.set({ nodes: graph('drag') });
    expect(w.latest()).toBe(before);
    w.dispose();
  });

  it('reading it changes NOTHING: no commit, no cancelled or re-armed timer (a render may read it twice)', () => {
    const w = watch({ previewCode: 'A', nodes: graph('n0') });
    w.atRest();
    w.store.set({ previewCode: 'B', nodes: graph('n1') });
    const timers = vi.getTimerCount();
    for (let i = 0; i < 5; i++) expect(w.latest()?.code).toBe('B');
    expect(vi.getTimerCount()).toBe(timers);
    expect(w.commits).toEqual([]);
    vi.advanceTimersByTime(DELAY);
    expect(w.commits.map((c) => c.code)).toEqual(['B']);
    w.dispose();
  });

  it('after a replacement it is the replacement’s own pair, committed in the same notification; the older held pair is gone', () => {
    const w = watch({ previewCode: 'old', nodes: graph('old') });
    w.atRest();
    w.store.set({ previewCode: 'edit', nodes: graph('edit') });
    expect(w.latest()?.code).toBe('edit');
    w.replaced();
    const fresh = graph('fresh');
    w.store.set({ previewCode: 'new', nodes: fresh });
    expect(w.commits).toEqual([{ code: 'new', nodes: fresh }]);
    expect(w.latest()).toBe(w.commits[0]);
    vi.advanceTimersByTime(5 * DELAY);
    expect(w.commits).toHaveLength(1);
    w.dispose();
  });
});

describe('adoptSettled / settledPreviewOf', () => {
  it('unchanged code keeps the PREVIOUS pair, identity included, so React bails', () => {
    const prev: SettledPreview = { code: 'A', nodes: graph('a') };
    expect(adoptSettled(prev, { code: 'A', nodes: graph('b') })).toBe(prev);
  });

  it('moved code takes the new pair whole, never a mix', () => {
    const prev: SettledPreview = { code: 'A', nodes: graph('a') };
    const next: SettledPreview = { code: 'B', nodes: graph('b') };
    expect(adoptSettled(prev, next)).toBe(next);
  });

  it('cuts the pair from ONE state, by reference', () => {
    const nodes = graph('n');
    const pair = settledPreviewOf({ previewCode: 'X', nodes });
    expect(pair).toEqual({ code: 'X', nodes });
    expect(pair.nodes).toBe(nodes);
  });
});

/* ── the race, end to end, in the preview document ───────────────────────── */

const PNG = `data:image/png;base64,${btoa('png!')}`;
const WEBP = `data:image/webp;base64,${btoa('webp')}`;

/** An import-built graph: the GLB builder re-mints the SAME ids on every import (`gi_img0_1`). */
function importedGraph(payload: string) {
  const nodes = [
    makeNode('gi_img0_1', 'imageNode', { imageB64: payload, width: 2, height: 2, fileName: 'tex.png', colorSpace: 'color' }),
    makeNode('gi_output', 'output'),
  ];
  const edges = [makeEdge('gi_img0_1', 'out', 'gi_output', 'color')];
  const code = graphToCode(nodes, edges).code;
  const keys = [...code.matchAll(/"fs-asset:([^"]+)"/g)].map((m) => m[1]);
  expect(keys).toHaveLength(1);
  return { nodes, code, key: keys[0] };
}

const minted: string[] = [];
afterEach(() => {
  for (const u of minted.splice(0)) URL.revokeObjectURL(u);
});

/**
 * Run a preview document's boot scripts in the order the browser reaches them:
 * the baked boot list (when there is one), the asset resolver, then the module
 * mint. All three are cut out of tslToPreviewHTML's real output and executed
 * against node's real Blob/URL/atob with a stand-in `window`; the module text
 * the document would import is recorded at its Blob, synchronously.
 */
function bootDocument(html: string) {
  const bootAt = html.indexOf('<script>window.__fsBootAssets = ');
  const resolverAt = html.indexOf(PREVIEW_ASSET_RESOLVER_SCRIPT);
  const mintAt = html.indexOf('  var __shaderCode = ');
  const mintTail = 'window.__shaderUrl = URL.createObjectURL(__shaderBlob);';
  const mintEnd = html.indexOf(mintTail, mintAt);
  expect(resolverAt).toBeGreaterThan(bootAt);
  expect(mintAt).toBeGreaterThan(resolverAt);
  expect(mintEnd).toBeGreaterThan(mintAt);
  const scripts: string[] = [];
  if (bootAt >= 0) scripts.push(html.slice(bootAt + '<script>'.length, html.indexOf('</script>', bootAt)));
  scripts.push(PREVIEW_ASSET_RESOLVER_SCRIPT.replace(/^<script>/, '').replace(/<\/script>$/, ''));
  scripts.push(html.slice(mintAt, mintEnd + mintTail.length));

  const parent = {};
  const listeners: ((ev: unknown) => void)[] = [];
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      if (type === 'message') listeners.push(fn);
    },
  };
  const moduleTexts: string[] = [];
  class RecordingBlob extends Blob {
    constructor(parts: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options);
      if (options?.type === 'text/javascript') moduleTexts.push(parts.join(''));
    }
  }
  const URLStub = {
    createObjectURL: (b: Blob) => {
      const u = URL.createObjectURL(b);
      minted.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => URL.revokeObjectURL(u),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'URL', 'Blob', 'atob', scripts.join('\n'))(win, URLStub, RecordingBlob, atob);
  expect(moduleTexts).toHaveLength(1);
  return {
    /** What the boot blob holds: the module the document imports first. */
    bootModule: moduleTexts[0],
    /** The parent's `fs:image-assets` post, as the resolver's message listener receives it. */
    post(data: unknown) {
      for (const fn of listeners) fn({ source: parent, data });
    },
    /** The swap receiver's mint: the module text with this document's blob: URLs in. */
    resolve: (code: string) => (win.__fsResolveAssets as (c: string) => string)(code),
  };
}

describe('the race, end to end: a cold rebuild inside the debounce', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('Mesh with Materials over an earlier import: the rebuilt document resolves its boot module, then runs the new one', () => {
    const first = importedGraph(PNG);
    const second = importedGraph(WEBP);
    // Same node id, different payload hash: only the nodes they came from hold each key.
    expect(second.key).not.toBe(first.key);

    // The hook's state, exactly as ShaderPreview reduces it.
    const store = fakeStore({ previewCode: first.code, nodes: first.nodes });
    const events = new EventTarget();
    let settled = settledPreviewOf(store.getState());
    const { latest, dispose } = watchSettledPreview({
      getState: store.getState,
      subscribe: store.subscribe,
      commit: (next) => { settled = adoptSettled(settled, next); },
      delayMs: DELAY,
      events,
    });
    vi.advanceTimersByTime(DELAY);

    // commitGlbImport: the model (a COLD key) and the graph change in one tick,
    // and the graph is announced; the sync engine has not produced its code.
    store.set({ nodes: second.nodes });
    events.dispatchEvent(new Event('fs:graph-merged'));

    // That render's document memo, with the settled pair. The cold rebuild's
    // own settle has nothing to add: the new graph has no code yet, and the
    // newest cut pair is the one already held.
    expect(latest()?.code).toBe(settled.code);
    const bakedModule = buildPreviewShaderModule(settled.code);
    const boot = planPreviewAssetFeed(new Set(), collectImageAssets(settled.nodes), bakedModule);
    expect(boot.entries.map((e) => e.key)).toEqual([first.key]);
    const doc = bootDocument(tslToPreviewHTML(settled.code, { geometry: 'sphere', shaderModule: bakedModule, imageAssets: boot.entries }));
    expect(doc.bootModule).not.toContain(IMAGE_ASSET_PREFIX);
    expect(doc.bootModule).toMatch(/\.src = "blob:[^"]+";/);

    // What the LIVE-store plan baked instead (the code before this fix): an
    // empty boot list, and the literal placeholder left for `img.src` — the
    // ERR_UNKNOWN_URL_SCHEME request and the 1x1 black fallback.
    const live = planPreviewAssetFeed(new Set(), collectImageAssets(store.getState().nodes), bakedModule);
    expect(live.entries).toEqual([]);
    const stale = bootDocument(tslToPreviewHTML(settled.code, { geometry: 'sphere', shaderModule: bakedModule, imageAssets: live.entries }));
    expect(stale.bootModule).toContain(`.src = "${IMAGE_ASSET_PREFIX}${first.key}";`);

    // The sync engine writes the new code: the flush settles it at once, with
    // the nodes it came from…
    store.set({ previewCode: second.code });
    expect(settled).toEqual({ code: second.code, nodes: second.nodes });
    // …and the swap (the load-time replay, before the model) plans from that
    // pair against what this document already holds.
    const module2 = buildPreviewShaderModule(settled.code);
    const feed = planPreviewAssetFeed(boot.sent, collectImageAssets(settled.nodes), module2);
    expect(feed.entries.map((e) => e.key)).toEqual([second.key]);
    doc.post({ type: PREVIEW_ASSETS_MESSAGE, entries: feed.entries });
    const running = doc.resolve(module2);
    expect(running).not.toContain(IMAGE_ASSET_PREFIX);
    expect(running).toMatch(/\.src = "blob:[^"]+";/);
    dispose();
  });

});

/* ── every cold rebuild settles first: the hooks, mounted with real React ──── */

function lastOf<T>(list: readonly T[]): T {
  expect(list.length).toBeGreaterThan(0);
  return list[list.length - 1];
}

/** What the mounted preview also reads from its store, through selectors, as ShaderPreview does. */
interface MountedSource extends PreviewSource {
  /** The cold inputs, folded (ShaderPreview's `coldInputsKey`). */
  readonly cold: string;
  /** The default material's settings, keyed as ShaderPreview keys them (`JSON.stringify`). */
  readonly settings: string;
  /** The boot hold (ShaderPreview's `bootMeshHeld`): no document while a cached mesh is read. */
  readonly bootHeld: boolean;
}

/** How a moved cold key is adopted: `useColdRebuildKey`, or one of the rejected shapes below. */
type ColdKeyHook = (coldInputsKey: string, settle: () => void) => readonly [key: string, pending: boolean];

/**
 * REJECTED (TRAP 2 in useSettledPreview.ts): the first cut, which settled and
 * adopted DURING the render in which the key moved. Mounted only to prove the
 * two holes the review found in it.
 */
function useColdKeyInRender(coldInputsKey: string, settle: () => void): readonly [string, boolean] {
  const [builtKey, setBuiltKey] = useState(coldInputsKey);
  if (builtKey !== coldInputsKey) {
    settle();
    setBuiltKey(coldInputsKey);
  }
  return [builtKey, builtKey !== coldInputsKey];
}

/** REJECTED (TRAP 3): adopting in the passive effect itself, which the graph→code pass may follow. */
function useColdKeyInEffect(coldInputsKey: string, settle: () => void): readonly [string, boolean] {
  const [builtKey, setBuiltKey] = useState(coldInputsKey);
  useEffect(() => {
    if (builtKey === coldInputsKey) return;
    settle();
    setBuiltKey(coldInputsKey);
  }, [builtKey, coldInputsKey, settle]);
  return [builtKey, builtKey !== coldInputsKey];
}

interface MountOptions {
  strict?: boolean;
  /** Key the document memo on the live inputs: TRAP 1, which ShaderPreview never does. */
  keyOnLiveInputs?: boolean;
  /** Settle the code alone, never the material settings' key (the review's premise for them). */
  codeOnly?: boolean;
  coldKey?: ColdKeyHook;
  /** The cold inputs at mount (default: a primitive). */
  cold?: string;
  /** Mount under the boot hold (a dropped model expected, its cached copy still being read). */
  bootHeld?: boolean;
  /** Gate the document on the boot hold alone, never on a pending first rebuild (the premise for `holdsDocument`). */
  bootHoldOnly?: boolean;
  /**
   * A graph→code sibling in useSyncEngine's shape, which writes the code of
   * the store's nodes in a PASSIVE effect. Mounted before or after the
   * preview: passive effects run in tree order.
   */
  sync?: { order: 'before' | 'after'; codeOf: (nodes: AppNode[]) => string };
}

/**
 * ShaderPreview's settle-and-bake path, reduced to what decides a bake: the
 * hooks it calls (useSettledPreview.ts), the module memo (the LIVE material
 * settings, only their debounced key a dep), the cold key and a document memo
 * keyed the way ShaderPreview keys its own (`[coldDocKey]`), baking a REAL
 * document from the settled pair, then its rebuild and hot-swap effects,
 * reduced to what the swap would post, and the document hold the iframe's
 * `srcDoc` is gated on (`holdsDocument`). Every input comes from a stand-in
 * store through `useSyncExternalStore`, so a write renders at the priority a
 * zustand write does. Mounted with react-dom/client on a stand-in container:
 * the components render nothing, so React DOM touches only the container's
 * listener methods and `window` (stubbed per test).
 */
function mountPreview(initial: PreviewSource, opts: MountOptions = {}) {
  const store = fakeStore<MountedSource>({
    ...initial,
    cold: opts.cold ?? '__primitive__|0|0',
    settings: 'null',
    bootHeld: opts.bootHeld ?? false,
  });
  const events = new EventTarget();
  const useColdKey = opts.coldKey ?? useColdRebuildKey;
  const bakes: { key: string; code: string; module: string; bootKeys: string[]; html: string }[] = [];
  const commits: { coldDocKey: string; code: string; module: string; bakedModule: string }[] = [];
  /** What the swap effect would post: a module the live document is not running. */
  const posts: { module: string; bakedModule: string }[] = [];
  /** Every document handed to the iframe (`srcDoc`), as the key it was baked under. */
  const attaches: string[] = [];
  /** Every RENDER of the preview (committed or not), with the key it was keyed under. */
  const renders: { coldDocKey: string; code: string }[] = [];
  function Preview() {
    const { settled, settlePending } = useSettledPreview({
      getState: store.getState,
      subscribe: store.subscribe,
      delayMs: DELAY,
      events,
    });
    const cold = useSyncExternalStore(store.subscribe, () => store.getState().cold);
    const settingsKey = useSyncExternalStore(store.subscribe, () => store.getState().settings);
    const [debouncedSettingsKey, settleSettings] = useDebounced(settingsKey, DELAY);
    const module = useMemo(
      () => buildPreviewShaderModule(settled.code, JSON.parse(settingsKey) ?? undefined),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [settled.code, debouncedSettingsKey],
    );
    const settle = useCallback(() => {
      settlePending();
      if (!opts.codeOnly) settleSettings();
    }, [settlePending, settleSettings]);
    const [coldDocKey, coldRebuildPending] = useColdKey(cold, settle);
    renders.push({ coldDocKey, code: settled.code });
    const docKey = opts.keyOnLiveInputs ? cold : coldDocKey;
    const doc = useMemo(() => {
      const boot = planPreviewAssetFeed(new Set(), collectImageAssets(settled.nodes), module);
      const html = tslToPreviewHTML(settled.code, { geometry: 'sphere', shaderModule: module, imageAssets: boot.entries });
      bakes.push({ key: docKey, code: settled.code, module, bootKeys: boot.entries.map((e) => e.key), html });
      return { key: docKey, module };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docKey]);
    // ShaderPreview's `waitingForBootMesh`: `runningModuleRef` stands in as
    // the "a document was attached" latch, exactly as there.
    const bootHeld = useSyncExternalStore(store.subscribe, () => store.getState().bootHeld);
    const running = useRef<string | null>(null);
    const held = opts.bootHoldOnly ? bootHeld : holdsDocument(bootHeld, coldRebuildPending, running.current !== null);
    // The iframe: `srcDoc={… !held ? previewHtml : undefined}`, keyed on the adopted key.
    const shown = useRef<object | null>(null);
    useEffect(() => {
      const src = held ? null : doc;
      if (src !== null && src !== shown.current) attaches.push(doc.key);
      shown.current = src;
    });
    // The rebuild effect, then the swap effect, in ShaderPreview's order, both gated on the hold.
    useEffect(() => {
      if (held) return;
      running.current = doc.module;
    }, [doc, held]);
    useEffect(() => {
      if (held) return;
      if (module === running.current) return;
      posts.push({ module, bakedModule: doc.module });
      running.current = module;
    }, [module, doc, held]);
    // Every COMMIT, with what the swap effect compares.
    useEffect(() => {
      commits.push({ coldDocKey, code: settled.code, module, bakedModule: doc.module });
    });
    return null;
  }
  function Sync() {
    const nodes = useSyncExternalStore(store.subscribe, () => store.getState().nodes);
    useEffect(() => { store.set({ previewCode: opts.sync!.codeOf(nodes) }); }, [nodes]);
    return null;
  }
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    namespaceURI: null,
    addEventListener() {},
    removeEventListener() {},
    ownerDocument: { addEventListener() {}, removeEventListener() {} },
  } as unknown as Element;
  const root = createRoot(container);
  const element = () => {
    const preview = createElement(Preview, { key: 'preview' });
    const sync = opts.sync ? createElement(Sync, { key: 'sync' }) : null;
    const children = !sync ? [preview] : opts.sync!.order === 'before' ? [sync, preview] : [preview, sync];
    const tree = createElement(Fragment, null, ...children);
    return opts.strict ? createElement(StrictMode, null, tree) : tree;
  };
  return {
    store,
    bakes,
    commits,
    posts,
    attaches,
    renders,
    /** Mount, or render the same tree again (no cold input moves). */
    async render() {
      await act(async () => { root.render(element()); });
    },
    /**
     * Store writes and timers inside an async act, as the app's own reach
     * React: every render, effect and microtask they cause is flushed.
     */
    async step(fn: () => void) {
      await act(async () => { fn(); });
    },
    /**
     * A cold move rendered at DISCRETE priority NOW, ahead of any
     * default-priority update still queued (the dropdown's change, the
     * toggle's click). Call inside `step`. As in the browser, `window.event`
     * is still that event while the microtasks its render queued run (they
     * run inside the dispatch), so the hook's adoption also renders at
     * discrete priority, ahead of a timer's commit React has not rendered:
     * React's rebase case, which a default-priority adoption never reaches.
     */
    moveDiscrete(cold: string) {
      const w = window as unknown as { event?: { type: string } };
      w.event = { type: 'change' };
      flushSync(() => { store.set({ cold }); });
      // Queued after the render's own microtasks (the adoption), so they see the event.
      queueMicrotask(() => { delete w.event; });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
    },
  };
}

/** Mounted on `source`, the mount's own arm settled and every log cleared. */
async function mountAtRest(source: PreviewSource, opts: MountOptions = {}) {
  const p = mountPreview(source, opts);
  await p.render();
  await p.step(() => { vi.advanceTimersByTime(DELAY); });
  p.bakes.length = 0;
  p.commits.length = 0;
  p.posts.length = 0;
  p.attaches.length = 0;
  p.renders.length = 0;
  return p;
}

describe('every cold rebuild bakes the newest code (useColdRebuildKey, mounted with the real React renderer)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // React DOM's commit reads `window.HTMLIFrameElement` (focus bookkeeping);
    // tslToPreviewHTML resolves asset URLs against `window.location`.
    vi.stubGlobal('window', { HTMLIFrameElement: class {}, location: { href: 'http://localhost/' } });
    consoleError = vi.spyOn(console, 'error');
  });
  afterEach(() => {
    // Clean up FIRST and assert last: a failing expect skips everything after
    // it, and under `isolate: false` the stubbed `window`,
    // `IS_REACT_ACT_ENVIRONMENT` and the fake timers would then leak into
    // whatever file this worker runs next.
    const errors = consoleError.mock.calls.slice();
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // React reports misuse (an update outside act, an update to another
    // component during render) through console.error: none is allowed here.
    expect(errors).toEqual([]);
  });

  /** Mounted on `before`'s graph, at rest; then the edit to `after`, 50 ms inside its debounce. */
  async function editThenWait(opts: MountOptions = {}) {
    const before = importedGraph(PNG);
    const after = importedGraph(WEBP);
    const p = await mountAtRest({ previewCode: before.code, nodes: before.nodes }, opts);
    // Resolution / Revert / From file…: ONE updateNodeData, then its code.
    await p.step(() => {
      p.store.set({ nodes: after.nodes });
      p.store.set({ previewCode: after.code });
      vi.advanceTimersByTime(50);
    });
    // Still inside the debounce: nothing settled, nothing re-rendered.
    expect(p.commits).toEqual([]);
    return { p, before, after };
  }

  /**
   * The review's V16: ONE store write changes the graph AND, through a
   * selector, the cold inputs (a Raymarch Output starting to drive while a
   * model is shown puts its window sphere in the model's place), while the
   * edit's code does not exist yet: the graph→code sibling writes it in a
   * passive effect of the very commit that moves the key.
   */
  async function graphEdit(opts: MountOptions & { order: 'before' | 'after' }) {
    const plain = importedGraph(PNG);
    const edited = importedGraph(WEBP);
    const codes = new Map([[plain.nodes, plain.code], [edited.nodes, edited.code]]);
    const p = await mountAtRest(
      { previewCode: plain.code, nodes: plain.nodes },
      { ...opts, cold: 'custom:7|0|0', sync: { order: opts.order, codeOf: (nodes) => codes.get(nodes)! } },
    );
    await p.step(() => { p.store.set({ nodes: edited.nodes, cold: '__primitive__|0|0' }); });
    return { p, plain, edited };
  }

  /** The review's V13: the edit's timer commits unrendered, a NEWER code is cut, and a discrete cold move renders first. */
  async function newerHeldBehindTheTimer(opts: MountOptions = {}) {
    const { p, after } = await editThenWait(opts);
    const newer = importedGraph(`data:image/png;base64,${btoa('newer')}`);
    await p.step(() => {
      vi.advanceTimersByTime(DELAY - 50); // the edit's timer: committed at default priority, not rendered
      p.store.set({ previewCode: newer.code, nodes: newer.nodes }); // cut, and held by the debounce
      p.moveDiscrete('custom:7|0|0'); // renders AHEAD of the timer's update
    });
    return { p, after, newer };
  }

  it('a payload change, then a Model switch inside the debounce: ONE bake, of the edit, and nothing to post', async () => {
    const { p, before, after } = await editThenWait();
    // The Model dropdown crosses the model boundary (GLB -> Sphere measured
    // 3-6 frames of the old picture before fix D): a cold rebuild NOW.
    await p.step(() => { p.store.set({ cold: 'custom:7|0|0' }); });
    expect(p.bakes).toHaveLength(1);
    expect(p.bakes[0]).toMatchObject({ key: 'custom:7|0|0', code: after.code, bootKeys: [after.key] });
    const oldModule = buildPreviewShaderModule(before.code);
    const newModule = buildPreviewShaderModule(after.code);
    // The commit that moved the inputs rebuilt nothing (the previous document
    // stays); the next one adopted the key with the edit settled.
    expect(p.commits).toEqual([
      { coldDocKey: '__primitive__|0|0', code: before.code, module: oldModule, bakedModule: oldModule },
      { coldDocKey: 'custom:7|0|0', code: after.code, module: newModule, bakedModule: newModule },
    ]);
    // The document boots the EDIT's picture, resolved: no swap left to post,
    // and the previous document stayed attached until it was replaced.
    expect(p.posts).toEqual([]);
    expect(p.attaches).toEqual(['custom:7|0|0']);
    const doc = bootDocument(p.bakes[0].html);
    expect(doc.bootModule).not.toContain(IMAGE_ASSET_PREFIX);
    expect(doc.bootModule).toMatch(/\.src = "blob:[^"]+";/);
    // The timer still fires with the SAME pair: a no-op, no commit, no bake.
    await p.step(() => { vi.advanceTimersByTime(DELAY); });
    expect(p.commits).toHaveLength(2);
    expect(p.bakes).toHaveLength(1);
    await p.unmount();
  });

  it('the same for the backend toggle and the watchdog: any move of the cold inputs settles first', async () => {
    for (const cold of ['__primitive__|1|0', '__primitive__|0|1']) {
      const { p, after } = await editThenWait();
      await p.step(() => { p.store.set({ cold }); });
      expect(p.bakes.map((b) => b.code)).toEqual([after.code]);
      expect(lastOf(p.commits)).toMatchObject({ coldDocKey: cold, code: after.code });
      expect(p.posts).toEqual([]);
      await p.unmount();
    }
  });

  it('under StrictMode too: double renders and the mount’s double effects still bake only the edit', async () => {
    const { p, after } = await editThenWait({ strict: true });
    await p.step(() => { p.store.set({ cold: 'custom:7|0|0' }); });
    expect(p.bakes.length).toBeGreaterThan(0);
    for (const b of p.bakes) expect(b.code).toBe(after.code);
    const newModule = buildPreviewShaderModule(after.code);
    expect(lastOf(p.commits)).toEqual({ coldDocKey: 'custom:7|0|0', code: after.code, module: newModule, bakedModule: newModule });
    expect(p.posts).toEqual([]);
    await p.unmount();
  });

  it('the timer has COMMITTED but React has not rendered it, and a discrete cold move jumps ahead: still the edit', async () => {
    // The timer's commit is a default-priority update; the dropdown's change
    // or the toggle's click renders at discrete priority FIRST and skips it.
    // A read of only what the debounce still holds finds nothing there (the
    // timer fired) and the document bakes the previous module.
    const { p, after } = await editThenWait();
    await p.step(() => {
      vi.advanceTimersByTime(DELAY);
      p.moveDiscrete('custom:7|0|0');
    });
    expect(p.bakes.map((b) => b.code)).toEqual([after.code]);
    const newModule = buildPreviewShaderModule(after.code);
    expect(lastOf(p.commits)).toEqual({ coldDocKey: 'custom:7|0|0', code: after.code, module: newModule, bakedModule: newModule });
    expect(p.posts).toEqual([]);
    await p.unmount();
  });

  it('a NEWER code held behind that unrendered commit, then a discrete cold move: the settle survives React’s rebase', async () => {
    // Settled DURING render (the first cut), the settle is a render-phase
    // update, which React keeps out of the hook's base state while the
    // timer's skipped update is still queued there: rendering that update
    // later rebased from the old base and DROPPED the settle (the premise
    // below). Settled after the commit, it is an ordinary update the rebase
    // replays.
    const { p, newer } = await newerHeldBehindTheTimer();
    const newModule = buildPreviewShaderModule(newer.code);
    // The scenario really reaches the rebase: the adoption rendered at the
    // discrete move's priority, AHEAD of the timer's commit, and React then
    // rendered that commit again under it (a second pass on the adopted key,
    // landing on the same pair). A default-priority adoption renders once.
    expect(p.renders.filter((r) => r.coldDocKey === 'custom:7|0|0').map((r) => r.code)).toEqual([newer.code, newer.code]);
    expect(p.bakes.map((b) => b.code)).toEqual([newer.code]);
    // Never back to an older module than the one baked.
    for (const c of p.commits.filter((x) => x.coldDocKey === 'custom:7|0|0')) expect(c.code).toBe(newer.code);
    expect(lastOf(p.commits)).toEqual({ coldDocKey: 'custom:7|0|0', code: newer.code, module: newModule, bakedModule: newModule });
    expect(p.posts).toEqual([]);
    // The newer code's own timer, later: a no-op.
    await p.step(() => { vi.advanceTimersByTime(DELAY); });
    expect(p.posts).toEqual([]);
    expect(p.bakes).toHaveLength(1);
    await p.unmount();
  });

  it('the premise: settled DURING render, the rebase takes the panel back to the OLDER module and the swap posts it', async () => {
    const { p, after, newer } = await newerHeldBehindTheTimer({ coldKey: useColdKeyInRender });
    expect(p.bakes.map((b) => b.code)).toEqual([newer.code]);
    expect(p.posts).toEqual([
      { module: buildPreviewShaderModule(after.code), bakedModule: buildPreviewShaderModule(newer.code) },
    ]);
    await p.unmount();
  });

  it('a material-settings edit, then a cold move inside ITS debounce: the bake carries the new settings', async () => {
    // The default material's settings reach the module only through
    // buildShaderModule's option, never through the code, so they have their
    // own debounce, and the cold rebuild settles it with the pair.
    const before = importedGraph(PNG);
    const p = await mountAtRest({ previewCode: before.code, nodes: before.nodes });
    const plain = buildPreviewShaderModule(before.code);
    const doubleSided = buildPreviewShaderModule(before.code, { side: 'double' });
    expect(doubleSided).not.toBe(plain);
    await p.step(() => {
      p.store.set({ settings: JSON.stringify({ side: 'double' }) });
      vi.advanceTimersByTime(50);
    });
    // Debounced: the panel still holds the module without them.
    expect(lastOf(p.commits).module).toBe(plain);
    await p.step(() => { p.store.set({ cold: 'custom:7|0|0' }); });
    expect(p.bakes.map((b) => b.module)).toEqual([doubleSided]);
    expect(lastOf(p.commits)).toMatchObject({ coldDocKey: 'custom:7|0|0', module: doubleSided, bakedModule: doubleSided });
    expect(p.posts).toEqual([]);
    // Their own timer, later: a no-op.
    await p.step(() => { vi.advanceTimersByTime(DELAY); });
    expect(p.bakes).toHaveLength(1);
    expect(p.posts).toEqual([]);
    await p.unmount();
  });

  it('the premise: settling the code alone bakes the PREVIOUS settings, which only the swap corrects', async () => {
    const before = importedGraph(PNG);
    const p = await mountAtRest({ previewCode: before.code, nodes: before.nodes }, { codeOnly: true });
    const plain = buildPreviewShaderModule(before.code);
    const doubleSided = buildPreviewShaderModule(before.code, { side: 'double' });
    await p.step(() => {
      p.store.set({ settings: JSON.stringify({ side: 'double' }) });
      vi.advanceTimersByTime(50);
    });
    await p.step(() => { p.store.set({ cold: 'custom:7|0|0' }); });
    expect(p.bakes.map((b) => b.module)).toEqual([plain]);
    await p.step(() => { vi.advanceTimersByTime(DELAY); });
    expect(p.posts).toEqual([{ module: doubleSided, bakedModule: plain }]);
    await p.unmount();
  });

  for (const order of ['before', 'after'] as const) {
    it(`a graph edit that moves the cold inputs itself bakes that edit’s OWN code (graph→code mounted ${order} the preview)`, async () => {
      const { p, edited } = await graphEdit({ order });
      const module = buildPreviewShaderModule(edited.code);
      expect(p.bakes.map((b) => [b.key, b.code])).toEqual([['__primitive__|0|0', edited.code]]);
      expect(lastOf(p.commits)).toEqual({ coldDocKey: '__primitive__|0|0', code: edited.code, module, bakedModule: module });
      expect(p.posts).toEqual([]);
      // The debounce's own commit of that code, later: a no-op.
      await p.step(() => { vi.advanceTimersByTime(DELAY); });
      expect(p.bakes).toHaveLength(1);
      expect(p.posts).toEqual([]);
      await p.unmount();
    });
  }

  it('the premise: adopted during render, or in the passive effect itself with graph→code after it, the PRE-edit code is baked', async () => {
    const rejected: [ColdKeyHook, 'before' | 'after'][] = [
      [useColdKeyInRender, 'before'],
      [useColdKeyInRender, 'after'],
      [useColdKeyInEffect, 'after'],
    ];
    for (const [coldKey, order] of rejected) {
      const { p, plain, edited } = await graphEdit({ coldKey, order });
      expect(p.bakes.map((b) => b.code), `${coldKey.name}, graph→code ${order}`).toEqual([plain.code]);
      // The edit reaches that document only by swap, a debounce later.
      await p.step(() => { vi.advanceTimersByTime(DELAY); });
      expect(p.posts.map((x) => x.module)).toEqual([buildPreviewShaderModule(edited.code)]);
      await p.unmount();
    }
    // In the passive effect itself it holds only while graph→code runs FIRST,
    // which is the component tree's order, not a rule anything enforces.
    const { p, edited } = await graphEdit({ coldKey: useColdKeyInEffect, order: 'before' });
    expect(p.bakes.map((b) => b.code)).toEqual([edited.code]);
    await p.unmount();
  });

  it('a cold input that moves and comes back before the adoption rebuilds nothing', async () => {
    const { p } = await editThenWait();
    await p.step(() => {
      p.moveDiscrete('custom:7|0|0');
      p.moveDiscrete('__primitive__|0|0');
    });
    expect(p.bakes).toEqual([]);
    expect(p.attaches).toEqual([]);
    expect(lastOf(p.commits).coldDocKey).toBe('__primitive__|0|0');
    await p.unmount();
  });

  it('the boot hold lifting in the very render that moves the cold key attaches ONE document, the new key’s', async () => {
    // A cached model landing: `previewMesh` lifts the boot hold AND moves the
    // cold key in one render, while the memo still holds the sphere bake (the
    // key is adopted after the commit's effects). Until a first document is
    // up, the pending rebuild holds the document too (`holdsDocument`).
    const before = importedGraph(PNG);
    const p = await mountAtRest({ previewCode: before.code, nodes: before.nodes }, { bootHeld: true });
    await p.step(() => { p.store.set({ bootHeld: false, cold: 'custom:7|0|0' }); });
    expect(p.attaches).toEqual(['custom:7|0|0']);
    expect(p.bakes.map((b) => b.key)).toEqual(['custom:7|0|0']);
    expect(p.posts).toEqual([]);
    await p.unmount();
  });

  it('the premise: gated on the boot hold alone, that render attaches the sphere bake only to replace it', async () => {
    const before = importedGraph(PNG);
    const p = await mountAtRest({ previewCode: before.code, nodes: before.nodes }, { bootHeld: true, bootHoldOnly: true });
    await p.step(() => { p.store.set({ bootHeld: false, cold: 'custom:7|0|0' }); });
    expect(p.attaches).toEqual(['__primitive__|0|0', 'custom:7|0|0']);
    await p.unmount();
  });

  it('holdsDocument: the boot hold, or a pending rebuild before any document is up; never once one is', () => {
    expect(holdsDocument(true, false, false)).toBe(true);
    expect(holdsDocument(true, false, true)).toBe(true);
    expect(holdsDocument(false, true, false)).toBe(true);
    // An attached document stays on screen while its replacement is adopted:
    // holding then would strip `srcDoc` from a live iframe.
    expect(holdsDocument(false, true, true)).toBe(false);
    expect(holdsDocument(false, false, false)).toBe(false);
    expect(holdsDocument(false, false, true)).toBe(false);
  });

  it('nothing pending: a cold move bakes the settled pair, once', async () => {
    const before = importedGraph(PNG);
    const p = await mountAtRest({ previewCode: before.code, nodes: before.nodes });
    await p.step(() => { p.store.set({ cold: 'custom:3|0|0' }); });
    expect(p.bakes.map((b) => [b.key, b.code])).toEqual([['custom:3|0|0', before.code]]);
    expect(p.posts).toEqual([]);
    await p.unmount();
  });

  it('a scrub NEVER rebuilds the document: its code settles once, on the hot path', async () => {
    const before = importedGraph(PNG);
    const p = await mountAtRest({ previewCode: before.code, nodes: before.nodes });
    // Twelve distinct codes, 50 ms apart (each a different picture, so each a
    // different module).
    const steps = Array.from({ length: 12 }, (_, i) => importedGraph(`data:image/png;base64,${btoa(`png!${i}`)}`));
    await p.step(() => {
      for (const s of steps) {
        p.store.set({ previewCode: s.code, nodes: s.nodes });
        vi.advanceTimersByTime(DELAY / 4);
      }
    });
    expect(p.commits).toEqual([]);
    // A re-render of the same cold inputs (any other state) is not a cold move.
    await p.render();
    await p.step(() => { vi.advanceTimersByTime(DELAY); });
    expect(p.bakes).toEqual([]);
    const last = lastOf(p.commits);
    expect(last.code).toBe(lastOf(steps).code);
    // The panel now holds a module the document was not baked with: the swap
    // effect posts it (fs:shader), once, and nothing rebuilds.
    expect(last.module).not.toBe(last.bakedModule);
    expect(p.posts).toEqual([{ module: last.module, bakedModule: last.bakedModule }]);
    await p.unmount();
  });

  it('TRAP 1, the premise: a document keyed on the LIVE inputs bakes the PREVIOUS pair and keeps it', async () => {
    // A memo keyed on the live inputs moves in the render in which they move,
    // before anything is settled. Hence ShaderPreview's `[coldDocKey]`
    // (previewRebuild.test.ts pins it).
    const { p, before, after } = await editThenWait({ keyOnLiveInputs: true });
    await p.step(() => { p.store.set({ cold: 'custom:7|0|0' }); });
    expect(p.bakes.map((b) => b.code)).toEqual([before.code]);
    const last = lastOf(p.commits);
    expect(last.code).toBe(after.code);
    expect(last.bakedModule).toBe(buildPreviewShaderModule(before.code));
    await p.unmount();
  });
});

describe('why the hot-swap effect does not re-run for the nodes alone', () => {
  it('two different codes can build the SAME module (buildShaderModule re-assembles what it parses)', () => {
    // So a new settled pair can leave `previewModule` byte-identical. The swap
    // effect's cleanup cancels the in-flight swap's ack watchdog, so a re-run
    // on `moduleNodes` would cancel it and bail without arming a new one;
    // previewRebuild.test.ts pins that the effect's deps leave it out.
    // An Apply that only adds a blank line inside the shader body: a new
    // `previewCode` (so a new settled pair), the same module (blank body lines
    // are dropped when the module is assembled).
    const { code } = importedGraph(PNG);
    const at = code.indexOf('=> {\n');
    expect(at).toBeGreaterThan(-1);
    const spaced = `${code.slice(0, at + 5)}\n${code.slice(at + 5)}`;
    expect(spaced).not.toBe(code);
    expect(buildPreviewShaderModule(spaced)).toBe(buildPreviewShaderModule(code));
  });
});

/* ── drift guards: the events are the app's own ──────────────────────────── */

describe('GRAPH_REPLACED_EVENTS are the events the app fires on a whole-graph replacement', () => {
  const SRC_ROOT = resolve(__dirname, '../..');
  const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), 'utf8');

  it('each one is dispatched where the graph is replaced', () => {
    const projectImport = read('engine/projectImport.ts');
    expect(projectImport).toContain("window.dispatchEvent(new CustomEvent('fs:graph-imported'));");
    expect(projectImport).toContain("export const GRAPH_MERGED_EVENT = 'fs:graph-merged';");
    expect(projectImport).toContain('window.dispatchEvent(new CustomEvent(GRAPH_MERGED_EVENT));');
    expect(read('store/useAppStore.ts')).toContain("window.dispatchEvent(new CustomEvent('fs:graph-new'));");
    expect([...GRAPH_REPLACED_EVENTS].sort()).toEqual(['fs:graph-imported', 'fs:graph-merged', 'fs:graph-new']);
  });

  it('the one path that writes its code synchronously announces FIRST (the bare-script import)', () => {
    // Every other replacement's code is written later, by the sync engine's
    // graph→code effect. The bare script's conversion calls requestCodeSync,
    // which sets `previewCode` in the same call chain, so the announcement
    // must precede it or the flush would miss that code.
    const src = read('engine/projectImport.ts');
    const at = src.indexOf('export function importShaderText(');
    const body = src.slice(at, src.indexOf('\n}\n', at));
    const announce = body.indexOf('announceGraphImport();');
    expect(announce).toBeGreaterThan(-1);
    expect(body.indexOf('applyConvertedScript(')).toBeGreaterThan(announce);
  });

  it('every fs:graph-* event name in the app is classified here', () => {
    // A NEW graph event must be decided on: if it replaces the graph, list it
    // in GRAPH_REPLACED_EVENTS; if not, exclude it here with the reason.
    const NOT_A_REPLACEMENT: readonly string[] = [];
    const names = new Set<string>();
    for (const rel of readdirSync(SRC_ROOT, { recursive: true }) as string[]) {
      if (!/\.(ts|tsx)$/.test(rel) || /\.test\.ts$/.test(rel)) continue;
      // The list's own home would make "still fired or heard" vacuous.
      if (rel.split(/[\\/]/).join('/') === 'components/Preview/settledPreview.ts') continue;
      for (const m of read(rel).matchAll(/'(fs:graph-[a-z-]+)'/g)) names.add(m[1]);
    }
    const classified = new Set<string>([...GRAPH_REPLACED_EVENTS, ...NOT_A_REPLACEMENT]);
    expect([...names].filter((n) => !classified.has(n))).toEqual([]);
    for (const n of GRAPH_REPLACED_EVENTS) expect(names.has(n), `${n} is no longer fired or heard anywhere`).toBe(true);
  });

  it('the documentation states the rule (CLAUDE.md or docs/dev)', () => {
    const docs = projectDocs();
    expect(docs).toContain('planned from the nodes the module was GENERATED from');
    expect(docs).toContain('`Preview/settledPreview.ts`');
    expect(docs).toContain('**the settled nodes are for asset planning ONLY**');
    // Fix D, and the residual it retired: a cold rebuild no longer bakes the
    // previous module, so no doc may say it still does.
    expect(docs).toContain('**every cold rebuild first commits the newest pair the debounce has cut**');
    // The pair a timer committed but React has not rendered counts too (a
    // click's render runs ahead of the timer's update), so the rule may not
    // narrow back to "the pair the debounce still holds".
    expect(docs).not.toContain('first commits the pair the debounce still holds');
    expect(docs).toContain('**Every cold rebuild settles first (fix D, 2026-10-09).**');
    expect(docs).not.toContain('still bakes the previous module, resolved, so the previous picture shows');
    // Its review: adopted after the commit's effects, the material settings
    // settled with the pair, and the claims that retracted.
    expect(docs).toContain("**Adopted after the commit's effects (review, 2026-10-09).**");
    expect(docs).not.toContain('the mirror plan and the material settings keep their own LIVE deps');
    expect(docs).not.toContain('A replacement is unchanged: its cold rebuild happens before its code exists');
  });

  it('the mounted block cleans up BEFORE it asserts, so a failure cannot leak its stubs into the next file', () => {
    // `isolate: false`: a failing expect skips what follows it, and a stubbed
    // `window`, `IS_REACT_ACT_ENVIRONMENT` or fake timers would then land on
    // whatever file this worker runs next (review 2026-10-09).
    const self = readFileSync(__filename, 'utf8');
    const at = self.indexOf("describe('every cold rebuild bakes the newest code");
    const hook = self.slice(self.indexOf('afterEach(() => {', at), self.indexOf('\n  });', self.indexOf('afterEach(() => {', at)));
    const assertAt = hook.indexOf('expect(');
    expect(assertAt).toBeGreaterThan(-1);
    for (const cleanup of ['consoleError.mockRestore();', 'vi.unstubAllGlobals();', 'vi.useRealTimers();']) {
      expect(hook.indexOf(cleanup), cleanup).toBeGreaterThan(-1);
      expect(hook.indexOf(cleanup), cleanup).toBeLessThan(assertAt);
    }
  });
});

/**
 * The desktop room's file-backed autosave, TS half (GLB Phase 6, S6), driven
 * through the REAL store against a fake bridge that behaves like autosave.rs:
 * images are content-addressed by SHA-256, a write whose `"imageRef":"fsimg-…"`
 * key names a missing image is refused with `E_MISSING_IMAGE <digest>` (the
 * exact key, as autosave.rs reads it), and every write rotates the one-deep
 * backup. The Rust half has its own `cargo test`; desktopIpcContract.test.ts
 * holds the two to one vocabulary.
 *
 * `isolate: false` shares the store, its 300 ms autosave timer and the globals
 * with later files: every test starts from a fresh stubbed localStorage and an
 * uninstalled runtime, and the file restores the stub, the clock, the
 * persistence switch and the runtime when it is done.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  useAppStore,
  setGraphPersistence,
  cancelPendingGraphSave,
  installDesktopAutosave,
  installedDesktopAutosave,
  flushPendingGraphSave,
  persistSavedGroups,
  parseStoredGraph,
  loadGraph,
  type SavedGroup,
} from '@/store/useAppStore';
import {
  BOOT_CALL_TIMEOUT_MS,
  answerDesktopCloseFlush,
  bootDesktopAutosave,
  registerDesktopCloseFlush,
} from '@/store/desktopAutosaveBoot';
import { makeNode } from '@/test-utils';
import { getNodeValues, type AppNode } from '@/types';
import { safeJsonReviver } from './safeJson';
import {
  AUTOSAVE_FLUSH_EVENT,
  DESKTOP_AUTOSAVE_MARKER_KEY,
  createDesktopAutosave,
  createSerialSaver,
  desktopImageRef,
  desktopRefsForStorage,
  materializeDesktopRefs,
  newMaterializeBudget,
  type DesktopAutosaveBridge,
  type DesktopAutosaveRuntime,
  type DesktopSlot,
} from './desktopAutosave';
import { readStoredViewport, VIEWPORT_KEY } from './viewportMemory';

const P = 'data:image/png;base64,AAAA';
const Q = 'data:image/png;base64,BBBB';
const BAD = 'data:image/svg+xml;base64,PHN2Zz4=';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let ls: Record<string, string>;

beforeEach(() => {
  cancelPendingGraphSave();
  installDesktopAutosave(null);
  vi.useFakeTimers();
  ls = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null),
    setItem: (k: string, v: string) => {
      ls[k] = String(v);
    },
    removeItem: (k: string) => {
      delete ls[k];
    },
  });
  setGraphPersistence(true);
  useAppStore.setState({ nodes: [], edges: [], pendingLimitNotices: [] });
  cancelPendingGraphSave();
});

afterEach(() => {
  cancelPendingGraphSave();
  installDesktopAutosave(null);
});

afterAll(() => {
  cancelPendingGraphSave();
  installDesktopAutosave(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setGraphPersistence(true);
  useAppStore.setState({ nodes: [], edges: [], pendingLimitNotices: [] });
});

// ---------------------------------------------------------------------------
// A fake autosave.rs
// ---------------------------------------------------------------------------

interface FakeBridge extends DesktopAutosaveBridge {
  calls: string[];
  docs: Map<string, Uint8Array>;
  images: Map<string, string>;
  puts: string[];
  writes: Array<{ slot: DesktopSlot; text: string }>;
  failWrite: unknown;
  failRead: unknown;
  failStatus: unknown;
}

function fakeBridge(): FakeBridge {
  const dec = new TextDecoder();
  const b: FakeBridge = {
    calls: [],
    docs: new Map(),
    images: new Map(),
    puts: [],
    writes: [],
    failWrite: null,
    failRead: null,
    failStatus: null,
    async status() {
      b.calls.push('status');
      if (b.failStatus) throw b.failStatus;
      return { dir: '/fake/autosave' };
    },
    async read(slot, which) {
      b.calls.push(`read:${slot}:${which}`);
      if (b.failRead) throw b.failRead;
      return b.docs.get(`${slot}:${which}`) ?? new Uint8Array(0);
    },
    async write(slot, body) {
      b.calls.push(`write:${slot}`);
      if (b.failWrite) throw b.failWrite;
      const text = dec.decode(body);
      for (const m of text.matchAll(/"imageRef":"fsimg-([0-9a-f]{64})"/g)) {
        if (!b.images.has(m[1])) throw `E_MISSING_IMAGE ${m[1]}`;
      }
      const prev = b.docs.get(`${slot}:current`);
      if (prev) b.docs.set(`${slot}:previous`, prev);
      b.docs.set(`${slot}:current`, body.slice());
      b.writes.push({ slot, text });
    },
    async imagePut(payload) {
      b.calls.push('imagePut');
      b.puts.push(payload);
      const d = sha(payload);
      b.images.set(d, payload);
      return d;
    },
    async imageGet(digest) {
      b.calls.push('imageGet');
      const p = b.images.get(digest);
      if (p === undefined) throw 'E_NOT_FOUND';
      return p;
    },
    async gc() {
      b.calls.push('gc');
      return 0;
    },
    async quarantine(slot) {
      b.calls.push(`quarantine:${slot}`);
      b.docs.delete(`${slot}:current`);
    },
    async closeReady() {
      b.calls.push('closeReady');
    },
  };
  return b;
}

const enc = (v: unknown) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

function imageNode(id: string, imageB64: string, extra: Record<string, unknown> = {}): AppNode {
  return {
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: { registryType: 'imageNode', label: 'Image', cost: 10, values: { imageB64, width: 1, height: 1, ...extra } },
  } as unknown as AppNode;
}

function storedImageNode(id: string, digest: string): unknown {
  return {
    id,
    type: 'shader',
    position: { x: 0, y: 0 },
    data: { registryType: 'imageNode', label: 'Image', cost: 10, values: { imageB64: '', width: 1, height: 1, imageRef: desktopImageRef(digest) } },
  };
}

function valuesOf(nodes: unknown[], id: string): Record<string, unknown> {
  const n = nodes.find((x) => (x as { id: string }).id === id) as { data: { values: Record<string, unknown> } };
  return n.data.values;
}

const notices = () => useAppStore.getState().pendingLimitNotices;
const edit = (nodes: AppNode[]) => {
  useAppStore.getState().setNodes(nodes, 'graph');
  vi.advanceTimersByTime(1000);
};
const flush = () => installedDesktopAutosave()!.flush();
const lastWrite = (b: FakeBridge, slot: DesktopSlot) =>
  JSON.parse([...b.writes].reverse().find((w) => w.slot === slot)!.text, safeJsonReviver);

/** A runtime installed with writes on, reporting into a list. */
function installRuntime(b: FakeBridge, failed: string[] = []): DesktopAutosaveRuntime {
  const rt = createDesktopAutosave(b, { onWriteFailed: (r) => failed.push(r), onWriteOk: () => {} });
  installDesktopAutosave(rt);
  rt.enableWrites();
  return rt;
}

// ---------------------------------------------------------------------------

describe('the writer', () => {
  it('stores each distinct image once, as a file ref, and never puts it again', async () => {
    const b = fakeBridge();
    installRuntime(b);
    edit([imageNode('a', P), imageNode('b', P), imageNode('c', Q), makeNode('s', 'sin')]);
    await flush();
    expect(b.puts).toEqual([P, Q]);
    const doc = lastWrite(b, 'graph');
    for (const [id, p] of [['a', P], ['b', P], ['c', Q]] as const) {
      const v = valuesOf(doc.nodes, id);
      expect(v.imageB64).toBe('');
      expect(v.imageRef).toBe(desktopImageRef(sha(p)));
    }
    expect(JSON.stringify(doc)).not.toContain('base64');

    const moved = useAppStore.getState().nodes.map((n) => ({ ...n, position: { x: 5, y: 5 } }));
    edit(moved);
    await flush();
    expect(b.puts).toHaveLength(2);
    expect(b.writes.filter((w) => w.slot === 'graph')).toHaveLength(2);
  });

  it('keeps an invalid payload inline and never puts it', async () => {
    const b = fakeBridge();
    installRuntime(b);
    edit([imageNode('x', BAD)]);
    await flush();
    expect(b.puts).toEqual([]);
    expect(valuesOf(lastWrite(b, 'graph').nodes, 'x').imageB64).toBe(BAD);
  });

  it('desktopRefsForStorage drops a stray ref, leaves other nodes alone and lists what it could not ref', () => {
    const sin = makeNode('s', 'sin');
    const stray = imageNode('y', BAD, { imageRef: 'img1-00000000-1' });
    const known = imageNode('k', P);
    const unknownA = imageNode('u1', Q);
    const unknownB = imageNode('u2', Q);
    const out = desktopRefsForStorage([sin, stray, known, unknownA, unknownB], (p) => (p === P ? sha(P) : undefined));
    expect(out.nodes[0]).toBe(sin);
    expect(getNodeValues(out.nodes[1])).not.toHaveProperty('imageRef');
    expect(getNodeValues(out.nodes[1]).imageB64).toBe(BAD);
    expect(getNodeValues(out.nodes[2])).toMatchObject({ imageB64: '', imageRef: desktopImageRef(sha(P)) });
    expect(out.nodes[3]).toBe(unknownA);
    expect(out.missing).toEqual([Q]);
    // Never mutates its input.
    expect(getNodeValues(known).imageB64).toBe(P);
  });

  it('writes nothing to localStorage while the runtime is installed', async () => {
    const b = fakeBridge();
    installRuntime(b);
    edit([makeNode('n', 'sin')]);
    await flush();
    expect(localStorage.getItem('fs:graph')).toBeNull();
    expect(b.calls).toContain('write:graph');
  });

  it('routes the library to its own slot, and graphPersistence gates both', async () => {
    const b = fakeBridge();
    installRuntime(b);
    const group: SavedGroup = { id: 'g1', name: 'G', color: '#6366f1', nodes: [imageNode('gi', P)], edges: [] };

    setGraphPersistence(false);
    edit([makeNode('n', 'sin')]);
    persistSavedGroups([group]);
    await flush();
    expect(b.calls).toEqual([]);

    setGraphPersistence(true);
    persistSavedGroups([group]);
    await flush();
    expect(b.calls).toContain('write:savedGroups');
    expect(localStorage.getItem('fs:savedGroups')).toBeNull();
    const lib = lastWrite(b, 'savedGroups');
    expect(Array.isArray(lib)).toBe(true);
    expect(valuesOf(lib[0].nodes, 'gi').imageRef).toBe(desktopImageRef(sha(P)));
  });

  it('two slots saving one new image share ONE put (their savers run concurrently)', async () => {
    const b = fakeBridge();
    let inFlight = 0;
    let maxInFlight = 0;
    const put = b.imagePut;
    b.imagePut = async (p) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        for (let i = 0; i < 5; i++) await Promise.resolve();
        return await put(p);
      } finally {
        inFlight--;
      }
    };
    const rt = createDesktopAutosave(b, { onWriteFailed: () => {}, onWriteOk: () => {} });
    installDesktopAutosave(rt);
    // The first desktop boot's shape: a graph and a library sharing one image,
    // both pending when writes are enabled.
    edit([imageNode('a', P)]);
    persistSavedGroups([{ id: 'g1', name: 'G', color: '#6366f1', nodes: [imageNode('gi', P)], edges: [] }]);
    rt.enableWrites();
    await rt.flush();
    expect(maxInFlight).toBe(1);
    expect(b.puts).toEqual([P]);
    expect(b.calls.filter((c) => c.startsWith('write:')).sort()).toEqual(['write:graph', 'write:savedGroups']);
    expect(valuesOf(lastWrite(b, 'savedGroups')[0].nodes, 'gi').imageRef).toBe(desktopImageRef(sha(P)));
  });

  it('writes an imageRef key only where it stored a ref, so a stray one cannot refuse every save', async () => {
    const b = fakeBridge();
    const failed: string[] = [];
    installRuntime(b, failed);
    // A crafted file can carry a ref-shaped key anywhere; no such image exists.
    const ghost = desktopImageRef('c'.repeat(64));
    const stray = makeNode('s', 'sin');
    (stray.data as { values: Record<string, unknown> }).values = { imageRef: ghost, nested: { imageRef: ghost } };
    edit([imageNode('a', P), stray]);
    await flush();
    expect(failed).toEqual([]);
    const text = [...b.writes].reverse().find((w) => w.slot === 'graph')!.text;
    expect(text.match(/"imageRef":/g)).toHaveLength(1);
    expect(valuesOf(lastWrite(b, 'graph').nodes, 'a').imageRef).toBe(desktopImageRef(sha(P)));
    // The live store is untouched: only the file's JSON leaves the key out.
    expect(getNodeValues(useAppStore.getState().nodes.find((n) => n.id === 's')!).imageRef).toBe(ghost);
  });

  it('puts a vanished image again when Rust reports it missing, without a notice', async () => {
    const b = fakeBridge();
    const failed: string[] = [];
    const rt = installRuntime(b, failed);
    rt.seedKnown([[P, sha(P)]]); // trusted, but not on disk
    edit([imageNode('a', P)]);
    await flush();
    expect(b.puts).toEqual([P]);
    expect(b.writes.filter((w) => w.slot === 'graph')).toHaveLength(1);
    expect(failed).toEqual([]);
  });
});

describe('createSerialSaver', () => {
  it('runs one at a time: three requests during a run cost exactly one more, which sees the latest state', async () => {
    let state = 0;
    const seen: number[] = [];
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const saver = createSerialSaver(async () => {
      seen.push(state);
      await gate;
    });
    saver.request();
    state = 1;
    saver.request();
    state = 2;
    saver.request();
    state = 3;
    saver.request();
    const first = release;
    gate = Promise.resolve();
    first();
    await saver.flush();
    expect(seen).toEqual([0, 3]);
  });

  it('survives a run that rejects', async () => {
    let runs = 0;
    const saver = createSerialSaver(async () => {
      runs++;
      throw new Error('boom');
    });
    saver.request();
    saver.request();
    await saver.flush();
    expect(runs).toBe(2);
  });
});

describe('the runtime', () => {
  it('writes nothing while writes are disabled, then writes the pending slot on enable', async () => {
    const b = fakeBridge();
    const rt = createDesktopAutosave(b, { onWriteFailed: () => {}, onWriteOk: () => {} });
    installDesktopAutosave(rt);
    edit([makeNode('n', 'sin')]);
    await rt.flush();
    expect(rt.writesEnabled).toBe(false);
    expect(b.calls).toEqual([]);
    rt.enableWrites();
    await rt.flush();
    expect(b.calls).toEqual(['write:graph']);
  });

  it('awaits the gate before the first write', async () => {
    const b = fakeBridge();
    const rt = createDesktopAutosave(b, { onWriteFailed: () => {}, onWriteOk: () => {} });
    installDesktopAutosave(rt);
    edit([makeNode('n', 'sin')]);
    let open!: () => void;
    rt.enableWrites(new Promise<void>((r) => (open = r)).then(() => b.calls.push('gate')));
    await Promise.resolve();
    expect(b.calls).toEqual([]);
    open();
    await rt.flush();
    expect(b.calls).toEqual(['gate', 'write:graph']);
  });
});

describe('the reader', () => {
  it('materializes refs, shares one string per image, and leaves an unreadable one dangling', async () => {
    const b = fakeBridge();
    b.images.set(sha(P), P);
    const cache = new Map<string, string | null>();
    const nodes = [storedImageNode('a', sha(P)), storedImageNode('b', sha(P)), storedImageNode('c', sha(Q))];
    const out = await materializeDesktopRefs(nodes, b, cache);
    expect(valuesOf(out, 'a')).toMatchObject({ imageB64: P });
    expect(valuesOf(out, 'a')).not.toHaveProperty('imageRef');
    expect(valuesOf(out, 'a').imageB64).toBe(valuesOf(out, 'b').imageB64);
    expect(valuesOf(out, 'c').imageRef).toBe(desktopImageRef(sha(Q)));
    expect(b.calls.filter((c) => c === 'imageGet')).toHaveLength(2); // cached
    expect(cache.get(sha(Q))).toBeNull();
  });

  it('bounds what one document may resolve through refs', async () => {
    const b = fakeBridge();
    b.images.set(sha(P), P);
    b.images.set(sha(Q), Q);
    const out = await materializeDesktopRefs(
      [storedImageNode('a', sha(P)), storedImageNode('b', sha(Q))],
      b,
      new Map(),
      newMaterializeBudget(P.length),
    );
    expect(valuesOf(out, 'a').imageB64).toBe(P);
    expect(valuesOf(out, 'b').imageB64).toBe('');
  });

  it('charges the budget once per DISTINCT image: a library of groups sharing one payload resolves whole', async () => {
    // The writer budgets the library per UNIQUE payload (LIBRARY_IMAGE_BUDGET_COUNT),
    // so N groups carrying one image are accepted with no notice; the boot then
    // spends ONE budget over the whole library. Charged per instance, the 2nd
    // group's ref already failed a 1 × payload budget (and the 11th a 64M one
    // at 6M each), was counted dangling, and was written back without its image.
    const b = fakeBridge();
    b.images.set(sha(P), P);
    const cache = new Map<string, string | null>();
    const budget = newMaterializeBudget(P.length);
    const groups = Array.from({ length: 11 }, (_, i) => [storedImageNode(`g${i}`, sha(P))]);
    const out: unknown[][] = [];
    for (const nodes of groups) out.push(await materializeDesktopRefs(nodes, b, cache, budget));
    for (let i = 0; i < 11; i++) expect(valuesOf(out[i], `g${i}`).imageB64, `group ${i}`).toBe(P);
    expect(budget.chars).toBe(P.length);
  });

  it('ignores junk nodes and a payload beside a ref', async () => {
    const b = fakeBridge();
    const beside = storedImageNode('x', sha(P)) as { data: { values: Record<string, unknown> } };
    beside.data.values.imageB64 = Q;
    const input = [null, 5, 'x', { data: { registryType: 'imageNode', values: 7 } }, beside];
    const out = await materializeDesktopRefs(input, b, new Map());
    expect(out).toBe(input);
    expect(b.calls).toEqual([]);
  });
});

describe('bootDesktopAutosave', () => {
  const graphDoc = (nodes: unknown[]) => enc({ nodes, edges: [] });

  it('returns null and installs nothing when the store is not there', async () => {
    const b = fakeBridge();
    b.failStatus = 'no bridge';
    expect(await bootDesktopAutosave(b)).toBeNull();
    expect(installedDesktopAutosave()).toBeNull();
  });

  it('restores a valid document with its images', async () => {
    const b = fakeBridge();
    b.images.set(sha(P), P);
    b.docs.set('graph:current', graphDoc([storedImageNode('a', sha(P))]));
    const res = (await bootDesktopAutosave(b))!;
    expect(res.graph!.strippedImages).toBe(0);
    expect(getNodeValues(res.graph!.nodes.find((n) => n.id === 'a')!).imageB64).toBe(P);
    expect(getNodeValues(res.graph!.nodes.find((n) => n.id === 'a')!)).not.toHaveProperty('imageRef');
    expect(res.groups).toEqual({ groups: [], strippedImages: 0, outputSectionsTrimmed: 0 });
  });

  it('counts an image that cannot be read as stripped (N8)', async () => {
    const b = fakeBridge();
    b.images.set(sha(P), P);
    b.docs.set('graph:current', graphDoc([storedImageNode('a', sha(P)), storedImageNode('b', sha(Q))]));
    const res = (await bootDesktopAutosave(b))!;
    expect(res.graph!.strippedImages).toBe(1);
    expect(getNodeValues(res.graph!.nodes.find((n) => n.id === 'b')!).imageB64).toBe('');
  });

  it('an image read that FAILS (not missing, not corrupt) pauses writes, so the good file is never collected', async () => {
    const b = fakeBridge();
    b.images.set(sha(P), P);
    b.docs.set('graph:current', graphDoc([storedImageNode('a', sha(P))]));
    b.imageGet = async () => {
      b.calls.push('imageGet');
      throw 'E_IO Permission denied';
    };
    const res = (await bootDesktopAutosave(b))!;
    expect(notices().map((n) => [n.kind, n.detail])).toEqual([['autosave-file-read-failed', 'Permission denied']]);
    useAppStore.getState().setNodes(res.graph!.nodes, 'graph');
    res.start();
    edit([makeNode('n', 'sin')]);
    await flush();
    expect(installedDesktopAutosave()!.writesEnabled).toBe(false);
    expect(b.calls).not.toContain('gc');
    expect(b.calls.some((c) => c.startsWith('write:'))).toBe(false);
    expect(new TextDecoder().decode(b.docs.get('graph:current')!)).toContain(desktopImageRef(sha(P)));
  });

  it('a hung image read times out into a failed read, not a dangling ref', async () => {
    const b = fakeBridge();
    b.docs.set('graph:current', graphDoc([storedImageNode('a', sha(P))]));
    b.imageGet = () => new Promise<string>(() => {});
    const boot = bootDesktopAutosave(b);
    await vi.advanceTimersByTimeAsync(BOOT_CALL_TIMEOUT_MS + 1);
    const res = (await boot)!;
    expect(notices().map((n) => [n.kind, n.detail])).toEqual([['autosave-file-read-failed', 'timed out']]);
    res.start();
    await flush();
    expect(b.calls.some((c) => c.startsWith('write:'))).toBe(false);
  });

  it('a corrupt image file stays a dangling ref (N8), and writes go on', async () => {
    const b = fakeBridge();
    b.docs.set('graph:current', graphDoc([storedImageNode('a', sha(P))]));
    b.imageGet = async () => {
      throw 'E_CORRUPT_IMAGE';
    };
    const res = (await bootDesktopAutosave(b))!;
    expect(res.graph!.strippedImages).toBe(1);
    expect(notices()).toEqual([]);
    useAppStore.getState().setNodes(res.graph!.nodes, 'graph');
    res.start();
    await flush();
    expect(b.calls).toContain('write:graph');
  });

  it('writes back a library the load had to repair, so the N8 notice does not repeat every launch', async () => {
    const b = fakeBridge();
    b.images.set(sha(P), P);
    const group = {
      id: 'g1',
      name: 'G',
      color: '#6366f1',
      nodes: [storedImageNode('ok', sha(P)), storedImageNode('gone', sha(Q))],
      edges: [],
    };
    b.docs.set('savedGroups:current', enc([group]));
    const res = (await bootDesktopAutosave(b))!;
    expect(res.groups.strippedImages).toBe(1);
    // App's seed writes the repaired library back while writes are still off.
    persistSavedGroups(res.groups.groups);
    useAppStore.getState().setNodes([], 'graph');
    res.start();
    await flush();
    expect(b.calls).toContain('write:savedGroups');
    // The next launch reads the repaired file: nothing left to strip.
    installDesktopAutosave(null);
    const again = (await bootDesktopAutosave(b))!;
    expect(again.groups.strippedImages).toBe(0);
    expect(again.groups.groups.map((g) => g.id)).toEqual(['g1']);
  });

  it('writes back a library the load had to TRIM (Output sections past the caps, decision 9), so that notice does not repeat either', async () => {
    // The web write-back (App.tsx `seedFromStored`) fires on EITHER count; the
    // desktop `start()` re-persists on the same two conditions, or the file
    // keeps its over-cap sections and raises output-sections-trimmed at
    // every launch, exactly as a dangling image ref raised N8.
    const b = fakeBridge();
    const out = makeNode('o1', 'output') as unknown as { data: Record<string, unknown> };
    out.data.materials = Array.from({ length: 12 }, (_, i) => ({ meshTargets: [`s${i}`] }));
    const group = { id: 'g1', name: 'G', color: '#6366f1', nodes: [out], edges: [] };
    b.docs.set('savedGroups:current', enc([group]));
    const res = (await bootDesktopAutosave(b))!;
    expect(res.groups.strippedImages).toBe(0);
    expect(res.groups.outputSectionsTrimmed).toBeGreaterThan(0);
    // App's seed writes the repaired library back while writes are still off.
    persistSavedGroups(res.groups.groups);
    useAppStore.getState().setNodes([], 'graph');
    res.start();
    await flush();
    expect(b.calls).toContain('write:savedGroups');
    // The next launch reads the trimmed file: nothing left to trim.
    installDesktopAutosave(null);
    const again = (await bootDesktopAutosave(b))!;
    expect(again.groups.outputSectionsTrimmed).toBe(0);
    expect(again.groups.groups.map((g) => g.id)).toEqual(['g1']);

    // Source pin: the desktop condition names both counts, like the web's.
    const boot = readFileSync(resolve(__dirname, '../store/desktopAutosaveBoot.ts'), 'utf8');
    const start = boot.slice(boot.indexOf('start() {'), boot.indexOf('runtime.enableWrites('));
    expect(start).toContain('groups.strippedImages > 0');
    expect(start).toContain('groups.outputSectionsTrimmed > 0');
  });

  it('when neither document in a slot parses, it is a failed read: notice, writes paused, backup kept', async () => {
    const b = fakeBridge();
    const badBackup = enc('also not json');
    b.docs.set('graph:current', enc('{"nodes": ['));
    b.docs.set('graph:previous', badBackup);
    ls['fs:graph'] = JSON.stringify({ nodes: [makeNode('stale', 'sin')], edges: [] });
    const res = (await bootDesktopAutosave(b))!;
    expect(b.calls).toContain('quarantine:graph');
    expect(notices().map((n) => [n.kind, n.detail])).toEqual([
      ['autosave-file-read-failed', 'the file and its backup are both damaged'],
    ]);
    useAppStore.getState().setNodes(res.graph!.nodes, 'graph');
    res.start();
    edit([makeNode('n', 'sin')]);
    await flush();
    expect(b.calls.some((c) => c.startsWith('write:'))).toBe(false);
    expect(b.docs.get('graph:previous')).toEqual(badBackup);
  });

  it('a damaged document with no backup is a failed read too; only two absent files migrate', async () => {
    const b = fakeBridge();
    b.docs.set('savedGroups:current', enc('[{"id": '));
    const res = (await bootDesktopAutosave(b))!;
    expect(b.calls).toContain('quarantine:savedGroups');
    expect(notices().map((n) => [n.kind, n.detail])).toEqual([
      ['autosave-file-read-failed', 'the file is damaged and there is no backup'],
    ]);
    res.start();
    await flush();
    expect(b.calls.some((c) => c.startsWith('write:'))).toBe(false);
  });

  it('quarantines an unparseable document and reads the backup, with no notice', async () => {
    const b = fakeBridge();
    b.docs.set('graph:current', enc('{"nodes": ['));
    b.docs.set('graph:previous', graphDoc([makeNode('prev', 'sin')]));
    const res = (await bootDesktopAutosave(b))!;
    expect(b.calls).toContain('quarantine:graph');
    expect(res.graph!.nodes.map((n) => n.id)).toEqual(['prev']);
    expect(notices()).toEqual([]);
  });

  it('a failed read pauses writes for the session and says so', async () => {
    const b = fakeBridge();
    b.failRead = 'E_IO boom';
    ls['fs:graph'] = JSON.stringify({ nodes: [makeNode('old', 'sin')], edges: [] });
    const res = (await bootDesktopAutosave(b))!;
    expect(res.graph!.nodes.map((n) => n.id)).toEqual(['old']);
    expect(notices().map((n) => [n.kind, n.detail])).toEqual([['autosave-file-read-failed', 'boom']]);
    res.start();
    edit([makeNode('n', 'sin')]);
    await flush();
    expect(installedDesktopAutosave()!.writesEnabled).toBe(false);
    expect(b.calls).not.toContain('gc');
    expect(b.calls.some((c) => c.startsWith('write:'))).toBe(false);
    expect(ls['fs:graph']).toContain('"old"'); // not written either
  });

  it('migrates from localStorage when both files are absent', async () => {
    const b = fakeBridge();
    ls['fs:graph'] = JSON.stringify({ nodes: [makeNode('m', 'sin')], edges: [] });
    const group: SavedGroup = { id: 'g1', name: 'G', color: '#6366f1', nodes: [makeNode('gm', 'cos')], edges: [] };
    ls['fs:savedGroups'] = JSON.stringify([group]);
    const res = (await bootDesktopAutosave(b))!;
    expect(res.graph).toEqual(loadGraph());
    expect(res.groups.groups.map((g) => g.id)).toEqual(['g1']);

    // start(): the migrated library becomes a file at once; localStorage is left alone.
    useAppStore.getState().setNodes(res.graph!.nodes, 'graph');
    res.start();
    await flush();
    expect(b.calls).toContain('write:savedGroups');
    expect(b.calls).toContain('write:graph');
    expect(ls['fs:savedGroups']).toBe(JSON.stringify([group]));
  });

  it('start(): drops a boot-time change, writes the SEEDED graph first, after the GC', async () => {
    const b = fakeBridge();
    b.docs.set('graph:current', graphDoc([makeNode('real', 'sin')]));
    const res = (await bootDesktopAutosave(b))!;
    // A mount effect touched the empty store while the files were read.
    edit([]);
    // App seeds the graph, then starts writes.
    useAppStore.getState().setNodes(res.graph!.nodes, 'graph');
    res.start();
    await flush();
    const graphWrites = b.writes.filter((w) => w.slot === 'graph');
    expect(graphWrites).toHaveLength(1);
    expect(JSON.parse(graphWrites[0].text).nodes.map((n: { id: string }) => n.id)).toEqual(['real']);
    expect(b.calls.indexOf('gc')).toBeGreaterThan(-1);
    expect(b.calls.indexOf('gc')).toBeLessThan(b.calls.indexOf('write:graph'));
    // The previous file is still the backup.
    expect(new TextDecoder().decode(b.docs.get('graph:previous')!)).toContain('"real"');
  });

  it('one notice per failure streak; a success resets it', async () => {
    const b = fakeBridge();
    const res = (await bootDesktopAutosave(b))!;
    res.start();
    await flush();
    b.failWrite = 'E_IO disk full';
    edit([makeNode('a', 'sin')]);
    await flush();
    edit([makeNode('b', 'sin')]);
    await flush();
    expect(notices().map((n) => [n.kind, n.detail])).toEqual([['autosave-file-failed', 'disk full']]);
    b.failWrite = null;
    edit([makeNode('c', 'sin')]);
    await flush();
    b.failWrite = 'E_IO disk full';
    edit([makeNode('d', 'sin')]);
    await flush();
    expect(notices().filter((n) => n.kind === 'autosave-file-failed')).toHaveLength(2);
  });

  it('marks a written graph file, which the viewport memory reads', async () => {
    ls[VIEWPORT_KEY] = '10,20,1';
    expect(readStoredViewport()).toBeNull(); // no fs:graph, no marker
    const b = fakeBridge();
    const res = (await bootDesktopAutosave(b))!;
    useAppStore.getState().setNodes([makeNode('n', 'sin')], 'graph');
    res.start();
    await flush();
    expect(ls[DESKTOP_AUTOSAVE_MARKER_KEY]).toBe('1');
    expect(ls['fs:graph']).toBeUndefined();
    expect(readStoredViewport()).toEqual({ x: 10, y: 20, zoom: 1 });
  });
});

describe('the desktop boot seed', () => {
  it('clears the undo history a keystroke during the read may have filled', () => {
    // The overlay stops the pointer, not the keyboard: a node added during the
    // read pushes a history entry holding the EMPTY pre-seed store.
    useAppStore.setState({ past: [], future: [] });
    useAppStore.getState().addNode(makeNode('early', 'sin'));
    expect(useAppStore.getState().past).toHaveLength(1);
    // App's desktop seed replaces the nodes (setNodes pushes no history) and
    // then clears the stacks, so undo has nothing to go back to.
    useAppStore.getState().setNodes([makeNode('seeded', 'sin')], 'graph');
    useAppStore.setState({ past: [], future: [] });
    useAppStore.getState().undo();
    expect(useAppStore.getState().nodes.map((n) => n.id)).toEqual(['seeded']);

    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const branch = app.slice(app.indexOf('if (__FS_DESKTOP__) {'), app.indexOf('const groupsReport = loadSavedGroupsReport();'));
    const seedAt = branch.indexOf('seedFromStored(saved, groups);');
    const clearAt = branch.indexOf('useAppStore.setState({ past: [], future: [] });');
    expect(seedAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(seedAt);
    expect(clearAt).toBeLessThan(branch.indexOf('docs?.start();'));
    useAppStore.setState({ past: [], future: [] });
  });
});

describe('the close flush', () => {
  it('flushPendingGraphSave saves an armed timer at once, and is a no-op without one', () => {
    const saves: DesktopSlot[] = [];
    installDesktopAutosave({
      save: (slot) => saves.push(slot),
      enableWrites() {},
      dropPending() {},
      writesEnabled: true,
      flush: async () => {},
      seedKnown() {},
    });
    useAppStore.getState().setNodes([makeNode('n', 'sin')], 'graph');
    flushPendingGraphSave();
    expect(saves).toEqual(['graph']);
    flushPendingGraphSave();
    vi.advanceTimersByTime(1000);
    expect(saves).toEqual(['graph']);
  });

  it('answers with the pending edit written and closeReady last', async () => {
    const b = fakeBridge();
    const res = (await bootDesktopAutosave(b))!;
    res.start();
    await flush();
    useAppStore.getState().setNodes([makeNode('late', 'sin')], 'graph'); // within 300 ms
    await answerDesktopCloseFlush(b);
    expect(b.calls[b.calls.length - 1]).toBe('closeReady');
    expect(lastWrite(b, 'graph').nodes.map((n: { id: string }) => n.id)).toEqual(['late']);
  });

  it('registers one listener on the flush event, which answers closeReady', async () => {
    const handlers: Array<() => void> = [];
    const listen = vi.fn(async (event: string, h: () => void) => {
      expect(event).toBe(AUTOSAVE_FLUSH_EVENT);
      handlers.push(h);
      return () => {};
    });
    vi.stubGlobal('window', { __TAURI__: { event: { listen } } });
    const b = fakeBridge();
    registerDesktopCloseFlush(b);
    registerDesktopCloseFlush(b);
    expect(listen).toHaveBeenCalledTimes(1);
    handlers[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(b.calls).toContain('closeReady');
  });
});

describe('the loader split is behaviour-free', () => {
  it('parseStoredGraph(JSON.parse(fs:graph)) equals loadGraph() for the web writer\'s own output', () => {
    const LV = 'Z' + String.fromCharCode(0x0101) + 'le';
    const label = makeNode('l', 'sin');
    (label.data as { label: string }).label = LV;
    edit([label, imageNode('a', P), imageNode('b', P), imageNode('c', Q)]);
    const raw = ls['fs:graph'];
    expect(raw).toContain('img1-'); // the duplicate rode as a web ref
    expect(parseStoredGraph(JSON.parse(raw, safeJsonReviver))).toEqual(loadGraph());
    expect(parseStoredGraph(null)).toBeNull();
    expect(parseStoredGraph({ nodes: 5 })).toBeNull();
  });
});

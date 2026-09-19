import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  meshToRecord,
  recordToMesh,
  meshCacheOutcome,
  meshCacheFullIdOf,
  savePreviewMeshToCache,
  announceMeshCacheFull,
  MESH_CACHE_FULL_EVENT,
} from './previewMeshCache';
import { createPreviewMesh, MESH_MAX_BYTES, type PreviewMesh } from './previewMesh';

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]; // "glTF"

function glbBytes(len = 32): Uint8Array {
  const b = new Uint8Array(len);
  b.set(GLB_MAGIC, 0);
  return b;
}

function makeMesh(name: string, bytes: Uint8Array): PreviewMesh {
  const r = createPreviewMesh(name, bytes);
  if (!('mesh' in r)) throw new Error(r.error);
  return r.mesh;
}

describe('meshToRecord', () => {
  it('keeps only the sanitized name and the bytes', () => {
    const rec = meshToRecord(makeMesh('teapot.glb', glbBytes()));
    expect(Object.keys(rec).sort()).toEqual(['bytes', 'name']);
    expect(rec.name).toBe('teapot.glb');
    expect(new Uint8Array(rec.bytes).slice(0, 4)).toEqual(new Uint8Array(GLB_MAGIC));
  });

  it('copies into an exactly-sized buffer (no oversized backing buffer stored)', () => {
    // A view into the middle of a bigger buffer: structured-cloning it directly
    // would persist the whole 4096-byte buffer, not the 32 bytes we care about.
    const backing = new ArrayBuffer(4096);
    const view = new Uint8Array(backing, 128, 32);
    view.set(GLB_MAGIC, 0);
    const rec = meshToRecord(makeMesh('x.glb', view));
    expect(rec.bytes.byteLength).toBe(32);
  });

  it('drops the derived text and the session id', () => {
    const mesh = makeMesh('shape.obj', new TextEncoder().encode('v 0 0 0\n'));
    expect(mesh.text).toBeDefined();
    const rec = meshToRecord(mesh) as Record<string, unknown>;
    expect(rec.text).toBeUndefined();
    expect(rec.id).toBeUndefined();
  });
});

describe('recordToMesh', () => {
  it('round-trips a mesh through the record form', () => {
    const original = makeMesh('teapot.glb', glbBytes());
    const restored = recordToMesh(meshToRecord(original));
    expect(restored).not.toBeNull();
    expect(restored!.name).toBe(original.name);
    expect(restored!.kind).toBe('glb');
    expect(restored!.bytes).toEqual(original.bytes);
  });

  it('re-derives text for the text formats', () => {
    const original = makeMesh('shape.obj', new TextEncoder().encode('v 1 2 3\n'));
    const restored = recordToMesh(meshToRecord(original));
    expect(restored!.text).toBe('v 1 2 3\n');
  });

  it('assigns a FRESH session id, so restoring forces an iframe rebuild', () => {
    const original = makeMesh('teapot.glb', glbBytes());
    const restored = recordToMesh(meshToRecord(original));
    // The rebuild key is `custom:<id>` — reusing the old id could let a stale
    // document keep the previous mesh.
    expect(restored!.id).toBeGreaterThan(original.id);
  });

  it('accepts a Uint8Array as well as an ArrayBuffer', () => {
    expect(recordToMesh({ name: 'a.glb', bytes: glbBytes() })).not.toBeNull();
    expect(recordToMesh({ name: 'a.glb', bytes: glbBytes().buffer })).not.toBeNull();
  });

  it('rejects malformed records instead of throwing', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'nope',
      {},
      { name: 'a.glb' },
      { bytes: glbBytes() },
      { name: 123, bytes: glbBytes() },
      { name: 'a.glb', bytes: 'not-bytes' },
      { name: 'a.glb', bytes: { length: 10 } },
    ]) {
      expect(recordToMesh(bad)).toBeNull();
    }
  });

  it('re-runs the full drop-time validation on cached bytes', () => {
    // The cache is same-origin storage, not a trusted channel — every check the
    // drop surface applies must apply again on restore.
    expect(recordToMesh({ name: 'a.exe', bytes: glbBytes() })).toBeNull();       // extension whitelist
    expect(recordToMesh({ name: 'a.glb', bytes: new Uint8Array(0) })).toBeNull(); // empty
    expect(recordToMesh({ name: 'a.glb', bytes: new Uint8Array(32) })).toBeNull(); // no glTF magic
    expect(
      recordToMesh({ name: 'a.obj', bytes: new Uint8Array(MESH_MAX_BYTES + 1) }),
    ).toBeNull(); // over the 64 MB cap
  });

  it('re-sanitizes a tampered file name', () => {
    const restored = recordToMesh({ name: '../../etc/pa$$wd.glb', bytes: glbBytes() });
    expect(restored!.name).toBe('pa-wd.glb');
  });
});

describe('meshCacheOutcome', () => {
  it('says saved / cleared on a completed write', () => {
    expect(meshCacheOutcome(true, 'complete')).toBe('saved');
    expect(meshCacheOutcome(false, 'complete')).toBe('cleared');
  });

  it('reports storage-full only for a QUOTA failure while saving a real model', () => {
    expect(meshCacheOutcome(true, 'quota')).toBe('storage-full');
    // A failed CLEAR must never claim a model will not be restored.
    expect(meshCacheOutcome(false, 'quota')).toBe('not-saved');
  });

  it('keeps every other failure silent', () => {
    expect(meshCacheOutcome(true, 'failed')).toBe('not-saved');
    expect(meshCacheOutcome(true, 'timeout')).toBe('not-saved');
    expect(meshCacheOutcome(true, null)).toBe('not-saved'); // no IndexedDB at all
  });
});

describe('meshCacheFullIdOf', () => {
  it('reads the mesh id off a well-formed event', () => {
    expect(meshCacheFullIdOf(new CustomEvent(MESH_CACHE_FULL_EVENT, { detail: { id: 3 } }))).toBe(3);
  });

  it('refuses anything that is not a positive safe integer on the right event', () => {
    for (const id of [0, -1, 1.5, '3', NaN, Infinity, 2 ** 60]) {
      expect(meshCacheFullIdOf(new CustomEvent(MESH_CACHE_FULL_EVENT, { detail: { id } }))).toBeNull();
    }
    expect(meshCacheFullIdOf(new CustomEvent(MESH_CACHE_FULL_EVENT))).toBeNull();
    expect(meshCacheFullIdOf(new CustomEvent(MESH_CACHE_FULL_EVENT, { detail: null }))).toBeNull();
    expect(meshCacheFullIdOf(new CustomEvent('fs:something-else', { detail: { id: 3 } }))).toBeNull();
    expect(meshCacheFullIdOf(new Event(MESH_CACHE_FULL_EVENT))).toBeNull();
  });

  it('announceMeshCacheFull is a no-op without a window (node env)', () => {
    expect(() => announceMeshCacheFull(1)).not.toThrow();
  });
});

describe('savePreviewMeshToCache (source pins — no IndexedDB in node)', () => {
  const src = readFileSync(resolve(__dirname, 'previewMeshCache.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function savePreviewMeshToCache('), src.indexOf('export async function loadPreviewMeshFromCache('));

  it('deletes the stale record in a follow-up transaction when a save fails — only while it is the newest save', () => {
    expect(body).toMatch(/if \(record && write !== 'complete' && gen === saveGen\) \{\s*await idbWrite\(db, STORE, \(store\) => \{ store\.delete\(RECORD_KEY\); \}\);/);
    // The copy-OOM branch's delete is guarded the same way.
    expect(body).toMatch(/if \(copyFailed\) \{\s*if \(gen === saveGen\) await idbWrite\(db, STORE, \(store\) => \{ store\.delete\(RECORD_KEY\); \}\);/);
    // The generation is taken before the first await, or a save that starts
    // while this one awaits could be numbered BELOW it.
    const genAt = body.indexOf('const gen = ++saveGen;');
    expect(genAt).toBeGreaterThan(-1);
    expect(genAt).toBeLessThan(body.indexOf('await '));
  });

  it('reports through meshCacheOutcome and never through a throw', () => {
    expect(body).toContain('return meshCacheOutcome(record !== null, write);');
    expect(body).toContain("if (!db) return 'not-saved';");
  });
});

// ── Behaviour against a spec-shaped fake IndexedDB ──────────────────────────
// Readwrite transactions on one store run in CREATION order (across
// connections too), one at a time; a failing one aborts with `tx.error` set.
// Just enough of the API for `idbSafe`'s openDb / idbWrite.

type FakeOp = { kind: 'put' | 'delete'; key: IDBValidKey; value?: unknown };
interface FakeTx { error: unknown; oncomplete: (() => void) | null; onabort: (() => void) | null; onerror: null }

function installFakeIdb(opts: {
  /** Error name a put of this record aborts with, or null to commit. */
  failPut?: (value: unknown) => string | null;
  /** How long a transaction holding this put runs, in ms. */
  putDelay?: (value: unknown) => number;
  /** An open that errors — what older engines did in a private window. */
  openFails?: boolean;
} = {}): Map<IDBValidKey, unknown> {
  const records = new Map<IDBValidKey, unknown>();
  const queue: { ops: FakeOp[]; tx: FakeTx; started: boolean }[] = [];
  const pump = (): void => {
    const head = queue[0];
    if (!head || head.started) return;
    head.started = true;
    const delay = Math.max(1, ...head.ops.map((o) => (o.kind === 'put' ? opts.putDelay?.(o.value) ?? 1 : 1)));
    setTimeout(() => {
      const failing = head.ops.map((o) => (o.kind === 'put' ? opts.failPut?.(o.value) ?? null : null)).find(Boolean);
      queue.shift();
      if (failing) {
        head.tx.error = { name: failing };
        head.tx.onabort?.();
      } else {
        for (const o of head.ops) {
          if (o.kind === 'put') records.set(o.key, o.value);
          else records.delete(o.key);
        }
        head.tx.oncomplete?.();
      }
      setTimeout(pump, 0);
    }, delay);
  };
  const db = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const ops: FakeOp[] = [];
      const tx: FakeTx & { objectStore: () => unknown } = {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        objectStore: () => ({
          put: (value: unknown, key: IDBValidKey) => { ops.push({ kind: 'put', key, value }); },
          delete: (key: IDBValidKey) => { ops.push({ kind: 'delete', key }); },
        }),
      };
      queue.push({ ops, tx, started: false });
      setTimeout(pump, 0); // the work callback runs synchronously first
      return tx;
    },
    close() {},
  };
  vi.stubGlobal('indexedDB', {
    open() {
      const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
      setTimeout(() => {
        if (opts.openFails) req.onerror?.();
        else { req.result = db; req.onsuccess?.(); }
      }, 1);
      return req;
    },
  });
  return records;
}

const nameOf = (rec: unknown): string | null =>
  rec && typeof rec === 'object' ? String((rec as { name?: unknown }).name) : null;
const objMesh = (name: string) => makeMesh(name, new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('savePreviewMeshToCache (fake IndexedDB)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a failed OLDER save never deletes a NEWER save that committed meanwhile', async () => {
    // A zip's large model (A) and a dropped small one (B) land a few ms apart.
    // A's put is slow and aborts on quota; B's put is created while A's is
    // still running, so it commits BEFORE A's follow-up delete is even created.
    const records = installFakeIdb({
      failPut: (v) => (nameOf(v) === 'big.obj' ? 'QuotaExceededError' : null),
      putDelay: (v) => (nameOf(v) === 'big.obj' ? 60 : 1),
    });
    records.set('current', { name: 'previous.obj', bytes: new ArrayBuffer(4) });
    const pa = savePreviewMeshToCache(objMesh('big.obj'));
    await wait(15);
    const pb = savePreviewMeshToCache(objMesh('small.obj'));
    const [ra, rb] = await Promise.all([pa, pb]);
    await wait(30); // let any trailing transaction run
    expect(rb).toBe('saved');
    // A still reports its quota failure — the store drops the notice because
    // A's model is no longer on screen.
    expect(ra).toBe('storage-full');
    expect(nameOf(records.get('current'))).toBe('small.obj');
  });

  it('a lone quota failure is still REPORTED and still deletes the stale record', async () => {
    const records = installFakeIdb({ failPut: () => 'QuotaExceededError' });
    records.set('current', { name: 'previous.obj', bytes: new ArrayBuffer(4) });
    expect(await savePreviewMeshToCache(objMesh('big.obj'))).toBe('storage-full');
    // A reload must not resurrect the PREVIOUS model under that notice.
    expect(records.has('current')).toBe(false);
  });

  it('a successful save replaces the record', async () => {
    const records = installFakeIdb();
    expect(await savePreviewMeshToCache(objMesh('a.obj'))).toBe('saved');
    expect(nameOf(records.get('current'))).toBe('a.obj');
    expect(await savePreviewMeshToCache(null)).toBe('cleared');
    expect(records.has('current')).toBe(false);
  });

  // Private windows are NOT detected — these pin what that means in practice.
  it('stays silent where a private window refuses IndexedDB (no factory, or a failed open)', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(await savePreviewMeshToCache(objMesh('a.obj'))).toBe('not-saved');
    vi.unstubAllGlobals();
    installFakeIdb({ openFails: true }); // older Firefox private browsing: open → InvalidStateError
    expect(await savePreviewMeshToCache(objMesh('a.obj'))).toBe('not-saved');
  });

  it('announces a real quota error even where a private window HAS IndexedDB — indistinguishable from a full disk', async () => {
    // Current Chrome/Firefox/Safari private windows: a working, smaller
    // IndexedDB whose refusal is named exactly like a full disk's.
    installFakeIdb({ failPut: () => 'QuotaExceededError' });
    expect(await savePreviewMeshToCache(objMesh('a.obj'))).toBe('storage-full');
  });
});

describe('CLAUDE.md states the mesh-cache notice honestly', () => {
  const doc = readFileSync(resolve(__dirname, '../../CLAUDE.md'), 'utf8');
  const line = doc.split('\n').find((l) => l.includes('previewMeshCache.ts —')) ?? '';

  it('does not claim a private window stays silent (nothing detects one)', () => {
    expect(line).not.toBe('');
    expect(line).not.toMatch(/private mode, no IndexedDB/);
    expect(line).toContain('a real quota error is announced even in a private window');
  });
});

/**
 * IndexedDB cache for the custom preview mesh, so a dropped model survives a
 * page reload.
 *
 * WHY NOT localStorage: it stores strings only (base64 would inflate the bytes
 * ~33%) inside a ~5-10 MB origin budget that the graph autosave already fills —
 * meshes run to `MESH_MAX_BYTES` (64 MB). IndexedDB stores binary natively with
 * a quota measured against free disk. The mesh still stays OUT of undo history
 * and the FASTSHADERS_PROJECT_V1 embed; this is a device-local convenience
 * cache, not part of the shader document (the zip export remains the portable
 * shader+mesh pair).
 *
 * SECURITY: cached bytes are treated exactly like a fresh drop — `recordToMesh`
 * routes them back through `createPreviewMesh`, so the extension whitelist, the
 * 64 MB cap, the GLB magic check, and the file-name sanitizer all re-run. The
 * mesh is still never parsed on the trusted side; it only ever crosses into the
 * sandboxed iframe via postMessage.
 *
 * Every entry point is throw-safe and resolves rather than rejects: a private
 * window, a blocked upgrade, a disabled IndexedDB, or a quota failure must
 * degrade to today's session-only behaviour, never break a drop or a boot.
 */

import { createPreviewMesh, type PreviewMesh } from './previewMesh';
import { withTimeout, openDb as openDbShared } from './idbSafe';

const DB_NAME = 'fastshaders';
const DB_VERSION = 1;
const STORE = 'previewMesh';
const RECORD_KEY = 'current';

/**
 * Whether the last session's geometry preference was the custom mesh, sampled
 * at MODULE INIT — which runs before React mounts.
 *
 * This snapshot is load-bearing. `usePersistedState('fs:previewGeometry', ...)`
 * seeds through `validateGeometry`, which downgrades a stored 'custom' to
 * 'sphere' whenever no mesh is loaded, and its persist effect writes that
 * downgrade straight back to localStorage. Restoring the mesh is asynchronous,
 * so it always loses that race — by the time the bytes arrive the stored
 * preference is already gone. Reading it here, before the clobber, is what lets
 * the boot path put the user back on their mesh.
 */
const bootGeometryWasCustomFlag = ((): boolean => {
  try {
    return localStorage.getItem('fs:previewGeometry') === 'custom';
  } catch {
    return false; // private mode / disabled storage
  }
})();

/** See `bootGeometryWasCustomFlag` — the pre-clobber geometry preference. */
export function bootGeometryWasCustom(): boolean {
  return bootGeometryWasCustomFlag;
}

/** Out-of-line keys (the single RECORD_KEY), so no `keyPath` store option. */
function openDb(): Promise<IDBDatabase | null> {
  return openDbShared(DB_NAME, DB_VERSION, STORE);
}

/** Serialize a mesh for storage. `text` and `id` are deliberately dropped:
 *  the text is re-derived on load and the id is a per-session identity. */
export function meshToRecord(mesh: PreviewMesh): { name: string; bytes: ArrayBuffer } {
  // Copy into an exactly-sized buffer — structured-cloning a view over a larger
  // buffer would persist the entire backing buffer.
  return { name: mesh.name, bytes: mesh.bytes.slice().buffer };
}

/**
 * Rebuild a mesh from whatever IndexedDB handed back. The stored record is
 * untrusted (another script on this origin, a half-written upgrade, a record
 * from a future version), so it goes through `createPreviewMesh` — the same
 * single constructor the drop surface and zip import use. A fresh session id is
 * assigned there, which is what forces the iframe rebuild on restore.
 */
export function recordToMesh(rec: unknown): PreviewMesh | null {
  if (!rec || typeof rec !== 'object') return null;
  const { name, bytes } = rec as { name?: unknown; bytes?: unknown };
  if (typeof name !== 'string') return null;

  let view: Uint8Array;
  if (bytes instanceof Uint8Array) view = bytes;
  else if (bytes instanceof ArrayBuffer) view = new Uint8Array(bytes);
  else return null;

  const result = createPreviewMesh(name, view);
  return 'mesh' in result ? result.mesh : null;
}

/** Persist the current mesh (or clear the cache when passed null). */
export async function savePreviewMeshToCache(mesh: PreviewMesh | null): Promise<void> {
  let record: { name: string; bytes: ArrayBuffer } | null = null;
  try {
    record = mesh ? meshToRecord(mesh) : null;
  } catch {
    return; // out of memory copying a huge mesh — leave the cache untouched
  }

  const db = await openDb();
  if (!db) return;
  try {
    await withTimeout(
      new Promise<void>((resolve) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, 'readwrite');
        } catch {
          return resolve();
        }
        try {
          const store = tx.objectStore(STORE);
          if (record) store.put(record, RECORD_KEY);
          else store.delete(RECORD_KEY);
        } catch {
          return resolve();
        }
        // Quota exceeded lands on onerror/onabort — a mesh that can't be cached
        // must still load for this session, so every path just resolves.
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      }),
      undefined,
    );
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

/** Restore the cached mesh, or null when there isn't a usable one. */
export async function loadPreviewMeshFromCache(): Promise<PreviewMesh | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const rec = await withTimeout(
      new Promise<unknown>((resolve) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, 'readonly');
        } catch {
          return resolve(null);
        }
        try {
          const req = tx.objectStore(STORE).get(RECORD_KEY);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          return resolve(null);
        }
        tx.onabort = () => resolve(null);
      }),
      null,
    );
    return recordToMesh(rec);
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

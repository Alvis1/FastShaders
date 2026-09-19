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
 * ONE outcome is also REPORTED: a quota failure while saving a model
 * (`savePreviewMeshToCache` returns 'storage-full', and the store raises
 * `fs:mesh-cache-full` for the model still on screen), because "your model will
 * not come back after a reload" is something the user can act on. No
 * IndexedDB, a failed open, a blocked upgrade, any other failure and a timeout
 * all stay silent.
 *
 * PRIVATE WINDOWS are not detected, and cannot be: a private window whose
 * engine refuses IndexedDB (older Firefox/Safari fail the open) lands on the
 * silent "failed open" path, but every current engine gives a private window a
 * working, smaller IndexedDB — and a QuotaExceededError there carries the SAME
 * name as a full disk. So a real quota refusal is announced in a private window
 * too. That is truthful rather than a leak: private-window storage survives a
 * reload within the session, so the model really will not come back.
 */

import { createPreviewMesh, type PreviewMesh } from './previewMesh';
import { openDb as openDbShared, idbWrite, idbGet, type IdbWriteResult } from './idbSafe';

const DB_NAME = 'fastshaders';
const DB_VERSION = 1;
const STORE = 'previewMesh';
const RECORD_KEY = 'current';

/**
 * Whether the last session's geometry preference was the custom mesh, sampled
 * at MODULE INIT — which runs before React mounts.
 *
 * It used to be the ONLY thing that got the user back onto their mesh: the
 * preference was downgraded to 'sphere' whenever no mesh was loaded and
 * `usePersistedState` wrote that downgrade straight back, so the asynchronous
 * restore always lost the race against its own boot. That is fixed at the
 * cause — the stored value is kept verbatim and the fallback is DERIVED
 * (`components/Preview/previewGeometryPref.ts`) — so this snapshot is now the
 * belt-and-braces half: with the preference intact the restore's
 * `setGeometry('custom')` is a no-op, and it still re-selects the model for
 * any path that legitimately moved the preference off 'custom' while the
 * bytes stayed cached. Sampled before React mounts either way, because a
 * snapshot taken later could only ever describe a preference something had
 * already had a chance to rewrite.
 */
const bootGeometryWasCustomFlag = ((): boolean => {
  try {
    return localStorage.getItem('fs:previewGeometry') === 'custom';
  } catch {
    return false; // private mode / disabled storage
  }
})();

/** See `bootGeometryWasCustomFlag` — the boot-time geometry preference. */
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

/**
 * What a cache save came to. `storage-full` is the ONLY one anybody is told
 * about, and only for a save of a real model: a failed CLEAR must never say a
 * model will not be restored.
 */
export type MeshCacheSaveResult = 'saved' | 'cleared' | 'storage-full' | 'not-saved';

/** Map a write outcome (null = no IndexedDB at all) onto a save result. */
export function meshCacheOutcome(hadMesh: boolean, write: IdbWriteResult | null): MeshCacheSaveResult {
  if (write === 'complete') return hadMesh ? 'saved' : 'cleared';
  if (write === 'quota' && hadMesh) return 'storage-full';
  return 'not-saved';
}

/**
 * "The model on screen could not be cached — storage is full." A window
 * CustomEvent carrying the mesh's session id, raised by the store and shown by
 * the 3D preview (which drops it unless that mesh is still the one loaded).
 */
export const MESH_CACHE_FULL_EVENT = 'fs:mesh-cache-full';

export function announceMeshCacheFull(id: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<{ id: number }>(MESH_CACHE_FULL_EVENT, { detail: { id } }));
}

/** The mesh id an `fs:mesh-cache-full` event names, or null for anything else. */
export function meshCacheFullIdOf(ev: Event): number | null {
  if (!(ev instanceof CustomEvent) || ev.type !== MESH_CACHE_FULL_EVENT) return null;
  const detail: unknown = ev.detail;
  if (!detail || typeof detail !== 'object') return null;
  const id = (detail as { id?: unknown }).id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Persist the current mesh (or clear the cache when passed null), and say how
 * it went. Never rejects.
 *
 * A write that does not complete also DELETES whatever record was there: the
 * put and the delete of the previous model share one transaction, so a failed
 * put leaves the PREVIOUS model under the key, and a reload would then
 * resurrect a different model under a notice saying nothing will be restored.
 * The delete is a separate transaction because an aborted one rolls back its
 * own delete too.
 *
 * That follow-up delete runs ONLY while this is still the newest save
 * (`gen === saveGen`). Readwrite transactions on one store run in CREATION
 * order, and the delete can only be created after the failed put has resolved —
 * by which time a newer save's put may already be queued ahead of it, so an
 * unconditional delete would run AFTER that put commits and remove the model
 * actually on screen, with nobody told (the older save's notice is suppressed
 * because its model is gone, and the newer one reported 'saved'). A superseded
 * save leaves the record to the newer save, whose own put or delete decides it.
 * The check and the transaction creation sit in one synchronous stretch, so a
 * save that starts after the check creates its put after the delete.
 */
let saveGen = 0;

export async function savePreviewMeshToCache(mesh: PreviewMesh | null): Promise<MeshCacheSaveResult> {
  const gen = ++saveGen; // before any await — see above
  let record: { name: string; bytes: ArrayBuffer } | null = null;
  let copyFailed = false;
  try {
    record = mesh ? meshToRecord(mesh) : null;
  } catch {
    copyFailed = true; // out of memory copying a huge mesh
  }

  const db = await openDb();
  if (!db) return 'not-saved';
  try {
    if (copyFailed) {
      if (gen === saveGen) await idbWrite(db, STORE, (store) => { store.delete(RECORD_KEY); });
      return 'not-saved';
    }
    // Quota exceeded lands on the transaction's onerror/onabort — a mesh that
    // can't be cached must still load for this session, so this only ever
    // REPORTS the failure; it never throws it.
    const write = await idbWrite(db, STORE, (store) => {
      if (record) store.put(record, RECORD_KEY);
      else store.delete(RECORD_KEY);
    });
    if (record && write !== 'complete' && gen === saveGen) {
      await idbWrite(db, STORE, (store) => { store.delete(RECORD_KEY); });
    }
    return meshCacheOutcome(record !== null, write);
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

/** Restore the cached mesh, or null when there isn't a usable one. */
export async function loadPreviewMeshFromCache(): Promise<PreviewMesh | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    // Whatever comes back is untrusted — `recordToMesh` re-runs the full
    // drop-time validation on it (see its own doc comment).
    return recordToMesh(await idbGet(db, STORE, RECORD_KEY));
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

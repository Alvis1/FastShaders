/**
 * Device-local stash of the PRE-OPTIMIZATION image payload, so an Image node
 * can be reverted after the drop-time power-of-two snap.
 *
 * WHY NOT ON THE NODE: `values` is the one surface every cap and validator
 * watches. `totalImageChars` and `sanitizeImageNodes` inspect ONLY
 * `values.imageB64`, so a second payload key would be invisible to the 600 K
 * per-image cap, the 3 M project cap, the 8 M hard ceiling AND the data-URL
 * whitelist — a tampered `.fastshader` could smuggle an unbounded, unvalidated
 * blob past the trust boundary. It would also ride ~101 `structuredClone`s of
 * undo history, the `fs:graph` autosave (already a known quota-failure path),
 * the clipboard, and the FASTSHADERS_PROJECT_V1 embed — roughly doubling an
 * image-heavy export. Only a ~16-char id lives on the node; the bytes live
 * here. Same reasoning, and the same shape, as `previewMeshCache.ts`.
 *
 * WHAT IS STORED is NOT the raw dropped file: that would re-embed the EXIF/GPS
 * the canvas round-trip exists to strip, and blow every cap. It is the payload
 * the import WOULD have produced without the snap — same codec policy, same
 * device cap, same 600 K budget — so it is bounded by construction and revert
 * is a validated field swap rather than a re-decode of untrusted bytes.
 *
 * KEYED BY CONTENT, not by node id: `pasteNodes` and the saved-group library
 * both mint fresh ids while cloning `data` unchanged, so an id-keyed record
 * would be lost by Ctrl+D. Hashing the stashed payload also makes the key
 * self-consistent with the encode parameters that produced it — the same file
 * dropped under a different headset texture cap yields different bytes, hence
 * a different record, instead of one silently overwriting the other.
 *
 * Every entry point is throw-safe and resolves rather than rejects: private
 * mode, a blocked upgrade, disabled IndexedDB or a quota failure must degrade
 * to "Revert unavailable", never break a drop.
 */

import { validImageDataUrl, HARD_MAX_IMAGE_ENCODED_CHARS, MAX_IMAGE_ENCODED_CHARS } from './imageNode';

const DB_NAME = 'fastshaders-images';
const DB_VERSION = 1;
const STORE = 'imageOrigins';

/** Ceiling on any single IndexedDB step (Safari private mode can leave a
 *  request pending forever). */
const IDB_TIMEOUT_MS = 5000;

/** Store-wide caps. A record can't exceed the per-image payload cap, so 32
 *  records is ~19 MB worst case; the byte cap binds first for big ones. */
const MAX_RECORDS = 32;
const MAX_STORE_CHARS = 24 * 1024 * 1024;

/** Session mirror, so a revert still works in private mode / with IndexedDB
 *  unavailable — the realistic "undo the snap ten seconds later" case. */
const memory = new Map<string, ImageOriginRecord>();
const MAX_MEMORY_RECORDS = 4;

export interface ImageOriginRecord {
  /** Shape version — anything else reads as a miss. */
  v: 1;
  /** Content id, duplicated in-record so a read self-verifies. */
  originId: string;
  /** The pre-snap payload as a validated `data:` URL. Stored as the string
   *  rather than raw bytes so restoring is validation-only. */
  dataUrl: string;
  width: number;
  height: number;
  /** Display-only, shown in the settings menu's Original row. */
  fileName: string;
  /** LRU ordering. */
  savedAt: number;
}

export interface ImageOriginPayload {
  dataUrl: string;
  width: number;
  height: number;
  fileName: string;
}

/**
 * Content id for a stashed payload: 128-bit FNV-1a (four independently seeded
 * 32-bit lanes) as hex.
 *
 * Deliberately not `crypto.subtle`: that is async and secure-context-only,
 * and whether the desktop build's custom-protocol origin qualifies is not
 * something a drop path should depend on. Collisions here cost a wrong
 * revert offer, not a security property — and `recordToPayload` re-validates
 * everything it hands back anyway.
 */
export function originIdFor(dataUrl: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x7fffffff, 0x2545f491];
  const lanes = new Uint32Array(seeds);
  for (let i = 0; i < dataUrl.length; i++) {
    const c = dataUrl.charCodeAt(i);
    for (let k = 0; k < 4; k++) {
      lanes[k] = Math.imul(lanes[k] ^ (c + k), 0x01000193);
    }
  }
  let out = '';
  for (let k = 0; k < 4; k++) out += lanes[k].toString(16).padStart(8, '0');
  return out;
}

/** Shape a payload for storage. Pure. */
export function payloadToRecord(payload: ImageOriginPayload, savedAt: number): ImageOriginRecord | null {
  const dataUrl = validImageDataUrl(payload.dataUrl);
  if (!dataUrl) return null;
  if (dataUrl.length > MAX_IMAGE_ENCODED_CHARS) return null;
  if (!Number.isInteger(payload.width) || payload.width <= 0) return null;
  if (!Number.isInteger(payload.height) || payload.height <= 0) return null;
  return {
    v: 1,
    originId: originIdFor(dataUrl),
    dataUrl,
    width: payload.width,
    height: payload.height,
    fileName: String(payload.fileName ?? '').slice(0, 64),
    savedAt,
  };
}

/**
 * Rebuild a payload from whatever IndexedDB handed back.
 *
 * The record is untrusted — another script on this origin, a half-written
 * upgrade, a record from a future version — so it re-enters through the same
 * `validImageDataUrl` whitelist that guards the live payload, exactly as
 * `previewMeshCache.recordToMesh` re-runs the drop-time mesh validation.
 * Any mismatch (version, key, dimensions, length) reads as a miss.
 */
export function recordToPayload(rec: unknown, expectedId: string): ImageOriginPayload | null {
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as Partial<ImageOriginRecord>;
  if (r.v !== 1) return null;
  if (typeof r.originId !== 'string' || r.originId !== expectedId) return null;

  const dataUrl = validImageDataUrl(r.dataUrl);
  if (!dataUrl) return null;
  if (dataUrl.length > HARD_MAX_IMAGE_ENCODED_CHARS) return null;
  // The id is a digest OF the payload — a record whose bytes no longer hash
  // to its own key has been tampered with or truncated.
  if (originIdFor(dataUrl) !== expectedId) return null;

  const width = Number(r.width);
  const height = Number(r.height);
  if (!Number.isInteger(width) || width <= 0 || width > 8192) return null;
  if (!Number.isInteger(height) || height <= 0 || height > 8192) return null;

  const fileName = typeof r.fileName === 'string' ? r.fileName.slice(0, 64) : '';
  return { dataUrl, width, height, fileName };
}

/** Resolve `fallback` if `p` hasn't settled in time (never rejects). */
function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (v: T) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(fallback), IDB_TIMEOUT_MS);
    p.then(
      (v) => { clearTimeout(timer); finish(v); },
      () => { clearTimeout(timer); finish(fallback); },
    );
  });
}

function openDb(): Promise<IDBDatabase | null> {
  return withTimeout(
    new Promise<IDBDatabase | null>((resolve) => {
      let factory: IDBFactory | undefined;
      try {
        factory = globalThis.indexedDB;
      } catch {
        /* access itself can throw in sandboxed/partitioned contexts */
      }
      if (!factory) return resolve(null);

      let req: IDBOpenDBRequest;
      try {
        req = factory.open(DB_NAME, DB_VERSION);
      } catch {
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'originId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // Another tab holds an older version open — skip rather than hang.
      req.onblocked = () => resolve(null);
    }),
    null,
  );
}

function rememberInMemory(rec: ImageOriginRecord): void {
  memory.set(rec.originId, rec);
  while (memory.size > MAX_MEMORY_RECORDS) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/**
 * Stash a pre-snap payload. Returns the id to put on the node, or null when
 * the payload itself was unusable — the caller MUST treat null as "no revert
 * available" and skip the destructive step rather than shipping damage with
 * no way back. Storage failures do NOT produce null: the session mirror still
 * serves this tab.
 */
export function stashImageOrigin(payload: ImageOriginPayload, now: number): string | null {
  const rec = payloadToRecord(payload, now);
  if (!rec) return null;
  rememberInMemory(rec);
  void saveImageOrigin(rec);
  return rec.originId;
}

/** Persist a record (fire-and-forget; every failure path resolves). */
export async function saveImageOrigin(rec: ImageOriginRecord): Promise<void> {
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
          store.put(rec);
          // LRU trim in the same transaction: read everything back, drop the
          // oldest until both caps hold.
          const all = store.getAll();
          all.onsuccess = () => {
            const rows = (all.result as ImageOriginRecord[]).filter((r) => r && typeof r.originId === 'string');
            rows.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)); // newest first
            let chars = 0;
            rows.forEach((r, i) => {
              chars += typeof r.dataUrl === 'string' ? r.dataUrl.length : 0;
              if (i >= MAX_RECORDS || chars > MAX_STORE_CHARS) {
                try { store.delete(r.originId); } catch { /* */ }
              }
            });
          };
        } catch {
          return resolve();
        }
        // Quota exceeded lands on onerror/onabort — a payload that can't be
        // cached must still leave the drop working, so every path resolves.
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

/** Read a stashed payload back, or null when there isn't a usable one. */
export async function loadImageOrigin(originId: string): Promise<ImageOriginPayload | null> {
  if (typeof originId !== 'string' || originId.length === 0) return null;

  const cached = memory.get(originId);
  if (cached) {
    const hit = recordToPayload(cached, originId);
    if (hit) return hit;
  }

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
          const req = tx.objectStore(STORE).get(originId);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          return resolve(null);
        }
        tx.onabort = () => resolve(null);
      }),
      null,
    );
    const payload = recordToPayload(rec, originId);
    if (payload) rememberInMemory(rec as ImageOriginRecord);
    return payload;
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

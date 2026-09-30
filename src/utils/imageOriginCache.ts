/**
 * Device-local IndexedDB stash of an Image node's ORIGINAL payload: content-keyed
 * (survives Ctrl+D/paste), written only when the stored payload stops being the
 * original, every entry point resolves. docs/dev/images-and-textures.md § Revert.
 */

import { validImageDataUrl, HARD_MAX_IMAGE_ENCODED_CHARS, MAX_IMAGE_ENCODED_CHARS } from './imageNode';
import { openDb as openDbShared, idbWrite, idbGet } from './idbSafe';
import { PLATFORM_CAPS } from './platformCaps';
import { valueNum } from './valueCoerce';

const DB_NAME = 'fastshaders-images';
const DB_VERSION = 1;
const STORE = 'imageOrigins';

/** Store-wide LRU caps, platform-sized (utils/platformCaps.ts). On the web the
 *  COUNT binds; the byte cap guards records this module did not write (up to
 *  the 8 M hard ceiling `recordToPayload` tolerates). On desktop it binds first. */
const MAX_RECORDS = PLATFORM_CAPS.originRecords;
const MAX_STORE_CHARS = PLATFORM_CAPS.originStoreChars;

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

/**
 * Whether a payload is one this cache will hold — the SAME rule
 * `payloadToRecord` applies, asked up front. The settings menu asks it before
 * offering the Resolution ladder for an unsnapped image: the ladder's first
 * pick stashes the payload it is about to replace, and a stash that would be
 * refused (a >600 K payload placed under ignore-limits) must disable the
 * control with the reason rather than let a resize ship with no way back.
 */
export function canStashPayload(dataUrl: unknown): boolean {
  const url = validImageDataUrl(dataUrl);
  return url !== null && url.length <= MAX_IMAGE_ENCODED_CHARS;
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

  const width = valueNum(r.width);
  const height = valueNum(r.height);
  if (!Number.isInteger(width) || width <= 0 || width > 8192) return null;
  if (!Number.isInteger(height) || height <= 0 || height > 8192) return null;

  const fileName = typeof r.fileName === 'string' ? r.fileName.slice(0, 64) : '';
  return { dataUrl, width, height, fileName };
}

/** Records are keyed BY their content digest, hence the in-line `keyPath`. */
function openDb(): Promise<IDBDatabase | null> {
  return openDbShared(DB_NAME, DB_VERSION, STORE, { keyPath: 'originId' });
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
    // Quota exceeded lands on the transaction's onerror/onabort — a payload
    // that can't be cached must still leave the drop working, so the outcome
    // `idbWrite` reports is ignored here.
    await idbWrite(db, STORE, (store) => {
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
    });
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
    // Whatever comes back is untrusted — `recordToPayload` re-runs the full
    // validation on it (see its own doc comment).
    const rec = await idbGet(db, STORE, originId);
    const payload = recordToPayload(rec, originId);
    if (payload) rememberInMemory(rec as ImageOriginRecord);
    return payload;
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

/**
 * Drop every stashed original — the study clean slate (`cleanSlateForStudy`)
 * calls this beside `setPreviewMesh(null)`: a participant's dropped source
 * images must not stay recoverable from the study machine's browser after
 * their session ends, and the consent text covers only the submitted package
 * and the event journal. Throw-safe, resolves on every outcome.
 */
export async function clearImageOrigins(): Promise<void> {
  memory.clear();
  const db = await openDb();
  if (!db) return;
  try {
    await idbWrite(db, STORE, (store) => {
      try { store.clear(); } catch { /* */ }
    });
  } finally {
    try { db.close(); } catch { /* */ }
  }
}

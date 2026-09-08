import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Read a persisted value: seed from localStorage through `validate`, which
 * must return the default for null/invalid input and may throw on malformed
 * JSON — any throw (including localStorage access itself, e.g. private mode)
 * falls back to `validate(null)`.
 */
export function readPersisted<T>(key: string, validate: (raw: string | null) => T): T {
  try { return validate(localStorage.getItem(key)); } catch { return validate(null); }
}

export interface PersistedStateOptions<T> {
  /** Turns the value into the stored string (default `String`). */
  serialize?: (v: T) => string;
  /**
   * Re-read the key when a project import overwrites the stored prefs
   * (`fs:project-imported` window event) so consumers pick up the imported
   * values without a page reload. Off by default — most persisted prefs are
   * not part of a project file.
   */
  reloadOnProjectImport?: boolean;
  /**
   * Defer the localStorage WRITE by this many ms (trailing, restarted on every
   * change). Opt-in and 0 by default, because for an ordinary preference the
   * synchronous write is one keystroke's worth of work and immediacy is worth
   * more than the saving.
   *
   * It exists for the values a POINTER DRAG changes: a range input fires
   * `input` per frame, so `fs:previewSubdivision` and `fs:previewUniformValues`
   * were serialized (the latter a whole `JSON.stringify` of the map) and
   * written to disk ~60×/s for the length of every scrub. Only the WRITE is
   * deferred — `value` is state and stays live on the very next render, so the
   * preview, the sliders and everything reading them are unaffected.
   *
   * The flush is on a timer, on a key change with a write still pending, and on
   * UNMOUNT of the component holding the hook — a value scrubbed and then
   * immediately torn down must not be lost. (Nothing can flush a TAB CLOSE mid-
   * drag; that is the one loss this trades for, and it is bounded by the delay.)
   *
   * KNOWN WINDOW, and the reason to keep the delay short: `exportShader.ts`
   * reads `fs:previewSubdivision` / `fs:previewUniformValues` back out of
   * localStorage imperatively when it builds the project block, so an export
   * fired inside the window carries the previous value. The timer starts at the
   * last pointer MOVE, i.e. before the release, and reaching the toolbar to
   * click EXPORT costs far more than the delay — but a long delay here would
   * make that reachable.
   */
  debounceMs?: number;
}

/**
 * React state persisted under a localStorage `key`: seeded via
 * `readPersisted(key, validate)` and written back through `serialize` on
 * every change. `validate`/`serialize` must be module-scope (stable
 * identities) so the persist effect only fires on value changes.
 */
export function usePersistedState<T>(
  key: string,
  validate: (raw: string | null) => T,
  options: PersistedStateOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const { serialize = String, reloadOnProjectImport = false, debounceMs = 0 } = options;
  const [value, setValue] = useState<T>(() => readPersisted(key, validate));

  /**
   * The pending write, as a closure over the key/value pair that scheduled it.
   * A ref rather than state: a deferred write must not itself cause a render,
   * and the unmount flush has to reach the LATEST pair after the effect that
   * scheduled it has already been cleaned up. Serializing inside the closure
   * rather than at schedule time is also where most of the saving is for a big
   * map — one `JSON.stringify` per settle instead of one per frame.
   */
  const pending = useRef<{ key: string; write: () => void } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current != null) { clearTimeout(timer.current); timer.current = null; }
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    p.write();
  }, []);

  useEffect(() => {
    // serialize() is inside the try with setItem, as it always has been: a
    // throwing serializer degrades to "not persisted", never to a broken render.
    const write = () => {
      try { localStorage.setItem(key, serialize(value)); } catch { /* private mode, quota */ }
    };
    if (debounceMs <= 0) { write(); return; }
    // A key change with a write still pending: land the OLD key's value before
    // the closure for it is replaced, or switching keys mid-scrub drops it.
    if (pending.current && pending.current.key !== key) flush();
    pending.current = { key, write };
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, debounceMs);
  }, [key, serialize, value, debounceMs, flush]);

  // Unmount only — `flush` is stable, so this effect never re-runs and its
  // cleanup is the last chance a deferred write gets.
  useEffect(() => flush, [flush]);

  useEffect(() => {
    if (!reloadOnProjectImport) return;
    const handler = () => setValue(readPersisted(key, validate));
    window.addEventListener('fs:project-imported', handler);
    return () => window.removeEventListener('fs:project-imported', handler);
  }, [key, validate, reloadOnProjectImport]);
  return [value, setValue];
}

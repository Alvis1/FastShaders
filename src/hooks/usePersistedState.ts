import { useEffect, useState } from 'react';
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
  const { serialize = String, reloadOnProjectImport = false } = options;
  const [value, setValue] = useState<T>(() => readPersisted(key, validate));
  useEffect(() => {
    try { localStorage.setItem(key, serialize(value)); } catch { /* */ }
  }, [key, serialize, value]);
  useEffect(() => {
    if (!reloadOnProjectImport) return;
    const handler = () => setValue(readPersisted(key, validate));
    window.addEventListener('fs:project-imported', handler);
    return () => window.removeEventListener('fs:project-imported', handler);
  }, [key, validate, reloadOnProjectImport]);
  return [value, setValue];
}

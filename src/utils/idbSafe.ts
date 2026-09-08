/**
 * The throw-safe IndexedDB plumbing both browser-side caches share
 * (`previewMeshCache` — the dropped preview model; `imageOriginCache` — the
 * Image node's pre-snap payload).
 *
 * "Throw-safe" is the whole contract, and it is not decoration: every failure
 * mode of IndexedDB in a browser must degrade to the session-only behaviour
 * that predates these caches, never to a rejected promise nobody catches.
 * Private mode, a partitioned/sandboxed context where reading
 * `globalThis.indexedDB` ITSELF throws, a blocked version upgrade held by
 * another tab, a quota error, and a factory (or a transaction) that simply
 * never answers are all covered — the last by a timeout, which is why every
 * entry point is bounded by `IDB_TIMEOUT_MS`.
 *
 * NB the vitest environment is `node`, which has no IndexedDB, so nothing here
 * can be covered by a test: the throw-safety has to be preserved by
 * inspection. That is exactly why the whole of it lives here and not in a copy
 * per cache — each keeps its own DB_NAME/DB_VERSION/STORE and its own record
 * codec, and shares the plumbing: opening (`openDb`), the write transaction
 * (`idbWrite`) and the keyed read (`idbGet`), all of which were byte-identical
 * between the two apart from the store's `keyPath` option and the few lines of
 * store work each does inside its own transaction.
 */

/** How long any single IndexedDB step may hang before we give up on it. */
export const IDB_TIMEOUT_MS = 5000;

/** Resolve `fallback` if `p` hasn't settled in time (never rejects). */
export function withTimeout<T>(p: Promise<T>, fallback: T, ms: number = IDB_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const finish = (v: T) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(fallback), ms);
    p.then(
      (v) => { clearTimeout(timer); finish(v); },
      () => { clearTimeout(timer); finish(fallback); },
    );
  });
}

/**
 * Open (and upgrade) one object store, resolving `null` on every failure path.
 *
 * This carries its OWN timeout rather than wrapping the open promise in
 * `withTimeout`, because a connection can still arrive after we have given up on
 * it and a dropped promise value has no owner: `withTimeout` merely ignores the
 * late resolution, so the IDBDatabase it carried would stay open — and open for
 * the tab's LIFETIME, since nothing else holds a reference to close it. That
 * matters twice over. A live connection pins the version, so it BLOCKS a later
 * `open(name, higherVersion)` from this tab or any other, which is the exact
 * "another tab holds an older version" case `onblocked` below exists to skip;
 * and every retry (a drop, a boot restore) can strand another one.
 *
 * Two paths reach that state and only one of them is the timeout:
 *   - the timeout fires and the factory answers afterwards;
 *   - `onblocked` fires, which resolves while the open request is STILL PENDING
 *     — if the blocking connection then closes, the upgrade proceeds and
 *     `onsuccess` delivers a handle nobody asked for any more.
 * So the settlement flag lives here, where both paths pass through `finish`.
 *
 * @param storeOptions passed to `createObjectStore` — imageOriginCache keys its
 *                     records by `originId`; previewMeshCache uses out-of-line
 *                     keys and passes nothing.
 */
export function openDb(
  name: string,
  version: number,
  store: string,
  storeOptions?: IDBObjectStoreParameters,
): Promise<IDBDatabase | null> {
  return new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    // Armed before anything that can settle synchronously, so `finish` always
    // has a timer to clear.
    const timer = setTimeout(() => finish(null), IDB_TIMEOUT_MS);

    function finish(db: IDBDatabase | null): void {
      if (settled) {
        // Too late for a caller — own it here rather than leak the connection.
        try { db?.close(); } catch { /* already closing / closed */ }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    }

    let factory: IDBFactory | undefined;
    try {
      factory = globalThis.indexedDB;
    } catch {
      /* access itself can throw in sandboxed/partitioned contexts */
    }
    if (!factory) return finish(null);

    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, version);
    } catch {
      return finish(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, storeOptions);
    };
    req.onsuccess = () => finish(req.result);
    req.onerror = () => finish(null);
    // Another tab holds an older version open — skip rather than hang.
    req.onblocked = () => finish(null);
  });
}

/**
 * Run one write transaction, resolving on EVERY outcome — complete, error,
 * abort, a `transaction()` that throws (store missing after a half-written
 * upgrade), and a `work` callback that throws.
 *
 * `work` gets the object store and does the caller's own bookkeeping inside the
 * same transaction: previewMeshCache puts or deletes its single record, while
 * imageOriginCache also runs its LRU trim there — which is why this takes a
 * callback rather than a value. The transaction LIFECYCLE is what the two share,
 * and leaving a copy of it in each cache is how one of them ends up missing an
 * `onabort` and hanging out the 5 s timeout instead of resolving at once.
 *
 * Resolving on failure is deliberate everywhere: a quota error must still leave
 * the drop (or the boot) working — these are convenience caches, and the
 * session-only behaviour that predates them is the correct degraded state.
 */
export function idbWrite(
  db: IDBDatabase,
  store: string,
  work: (objectStore: IDBObjectStore) => void,
): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(store, 'readwrite');
      } catch {
        return resolve();
      }
      try {
        work(tx.objectStore(store));
      } catch {
        return resolve();
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    }),
    undefined,
  );
}

/**
 * Read one record by key, resolving `null` on every failure path (see
 * `idbWrite` for why every path resolves).
 *
 * The value is `unknown` on purpose: what comes back was written by an earlier
 * version of this app, or by anything else on this origin, so each cache
 * re-validates it through its own record codec rather than casting.
 */
export function idbGet(db: IDBDatabase, store: string, key: IDBValidKey): Promise<unknown> {
  return withTimeout(
    new Promise<unknown>((resolve) => {
      let tx: IDBTransaction;
      try {
        tx = db.transaction(store, 'readonly');
      } catch {
        return resolve(null);
      }
      try {
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        return resolve(null);
      }
      tx.onabort = () => resolve(null);
    }),
    null,
  );
}

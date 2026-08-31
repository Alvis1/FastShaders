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
 * another tab, a quota error, and a factory that simply never answers are all
 * covered — the last by the timeout, which is why every entry point runs
 * through `withTimeout`.
 *
 * NB the vitest environment is `node`, which has no IndexedDB, so nothing here
 * can be covered by a test: the throw-safety has to be preserved by
 * inspection. Each cache keeps its own DB_NAME/DB_VERSION/STORE — only the
 * plumbing is shared, and only because the two copies were byte-identical
 * apart from the store's `keyPath` option.
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
        req = factory.open(name, version);
      } catch {
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, storeOptions);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // Another tab holds an older version open — skip rather than hang.
      req.onblocked = () => resolve(null);
    }),
    null,
  );
}

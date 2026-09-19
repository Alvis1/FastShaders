/**
 * The desktop room's file-backed autosave, frontend half (GLB Phase 6, S6).
 *
 * localStorage holds ~5.24M characters per origin and a desktop project may
 * carry ~32M characters of images, so in the desktop build `fs:graph` and
 * `fs:savedGroups` are written to files under the app data directory instead
 * (`src-tauri/src/autosave.rs`). The document is the SAME JSON value the web
 * writes, with one difference: every valid image payload is stored once as
 * `images/<sha256>.txt`, and the node carries `imageB64: ''` plus
 * `imageRef: 'fsimg-<sha256>'`. Rust computes that digest from the bytes it
 * stores and re-verifies it on every read; the webview never names a file.
 *
 * Everything that touches Tauri goes through {@link DesktopAutosaveBridge}, so
 * the writer, the reader and the serial saver are node-tested against a fake
 * bridge driving the real store (desktopAutosave.test.ts). The store imports
 * only the TYPES here (the costTable lesson: no module-scope evaluation across
 * the store's import cycle), and the boot that wires it up lives in
 * `store/desktopAutosaveBoot.ts`, a desktop-only chunk.
 *
 * Adversarial input: a stored document is local-app-data, the same trust level
 * as localStorage, so the reader materializes refs by plain property access and
 * leaves every judgement about the payload to the SAME sanitizers the web
 * restore runs (`parseStoredGraph` / `parseStoredGroupsReport`).
 */
import type { AppNode } from '@/types';
import { IMAGE_REF_KEY, validImageDataUrl } from './imageNode';
import { MAX_REF_RESOLVED_IMAGE_CHARS } from './imagePayloadRefs';
import { invokeDesktop } from './tauriBridge';
import { describeDesktopError, desktopBytes, parseDesktopError } from './desktopIpc';
import { DESKTOP_AUTOSAVE_MARKER_KEY } from './viewportMemory';

export { DESKTOP_AUTOSAVE_MARKER_KEY };

/** The Rust commands (`autosave.rs`), pinned by desktopIpcContract.test.ts. */
export const AUTOSAVE_CMD = {
  status: 'autosave_status',
  read: 'autosave_read',
  write: 'autosave_write',
  imagePut: 'autosave_image_put',
  imageGet: 'autosave_image_get',
  gc: 'autosave_gc',
  quarantine: 'autosave_quarantine',
  closeReady: 'autosave_close_ready',
} as const;

/** Names the slot of an `autosave_write` raw body. Rust: `SLOT_HEADER`. */
export const SLOT_HEADER = 'x-fs-slot';

/** Rust emits this on window close / app quit; the webview flushes, then
 *  invokes `autosave_close_ready`. Rust: `FLUSH_EVENT`. */
export const AUTOSAVE_FLUSH_EVENT = 'fs:autosave-flush';

export type DesktopSlot = 'graph' | 'savedGroups';
export const DESKTOP_SLOTS: readonly DesktopSlot[] = ['graph', 'savedGroups'];

/** A stored ref: `fsimg-` + the 64-hex SHA-256 Rust computed (autosave.rs
 *  `REF_PREFIX` + `DIGEST_LEN`). */
export const DESKTOP_IMAGE_REF_RE = /^fsimg-([0-9a-f]{64})$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export const desktopImageRef = (digest: string): string => `fsimg-${digest}`;

export interface DesktopAutosaveBridge {
  status(): Promise<{ dir: string }>;
  /** Length 0 = the file is absent. */
  read(slot: DesktopSlot, which: 'current' | 'previous'): Promise<Uint8Array>;
  write(slot: DesktopSlot, body: Uint8Array): Promise<void>;
  /** Rust computes and returns the SHA-256 hex of the payload bytes. */
  imagePut(payload: string): Promise<string>;
  /** Rejects `E_NOT_FOUND` / `E_CORRUPT_IMAGE`. */
  imageGet(digest: string): Promise<string>;
  gc(): Promise<number>;
  quarantine(slot: DesktopSlot): Promise<void>;
  closeReady(): Promise<void>;
}

/** The real bridge, over `invokeDesktop`. Reads come back as raw bytes
 *  (`tauri::ipc::Response`); writes send raw bytes as the request body. */
export function tauriAutosaveBridge(): DesktopAutosaveBridge {
  const decode = (data: unknown): string =>
    new TextDecoder('utf-8', { fatal: true }).decode(desktopBytes(data));
  return {
    status: () => invokeDesktop<{ dir: string }>(AUTOSAVE_CMD.status),
    read: async (slot, which) => desktopBytes(await invokeDesktop<unknown>(AUTOSAVE_CMD.read, { slot, which })),
    write: (slot, body) =>
      invokeDesktop<void>(AUTOSAVE_CMD.write, body, { headers: { [SLOT_HEADER]: slot } }),
    imagePut: (payload) => invokeDesktop<string>(AUTOSAVE_CMD.imagePut, new TextEncoder().encode(payload)),
    imageGet: async (digest) => decode(await invokeDesktop<unknown>(AUTOSAVE_CMD.imageGet, { digest })),
    gc: () => invokeDesktop<number>(AUTOSAVE_CMD.gc),
    quarantine: (slot) => invokeDesktop<void>(AUTOSAVE_CMD.quarantine, { slot }),
    closeReady: () => invokeDesktop<void>(AUTOSAVE_CMD.closeReady),
  };
}

// ---------------------------------------------------------------------------
// Node shape (the imagePayloadRefs rules: plain property access, never `in`)
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null;
}

/** An Image node's `values` object, or null for anything else. */
function imageValuesOf(node: unknown): Obj | null {
  if (!isObj(node)) return null;
  const data = node.data;
  if (!isObj(data) || data.registryType !== 'imageNode') return null;
  const values = data.values;
  return isObj(values) && !Array.isArray(values) ? values : null;
}

function withValues<T>(node: T, values: Obj): T {
  const n = node as Obj;
  return { ...n, data: { ...(n.data as Obj), values } } as T;
}

// ---------------------------------------------------------------------------
// WRITER
// ---------------------------------------------------------------------------

/** A document one slot writes: the live nodes whose payloads it holds, and how
 *  to build the stored value once each payload has a digest. */
export interface DesktopDocument {
  nodes: readonly AppNode[];
  build(storeImages: (nodes: AppNode[]) => AppNode[]): unknown;
}

/**
 * The file store's node list. An Image node whose payload has a digest is
 * written `imageB64: ''` plus `imageRef: 'fsimg-<digest>'`; a stray ref is
 * dropped first (the `rewriteForStorage` rule). A VALID payload with no digest
 * yet is listed in `missing` (once each) and stays inline; an invalid payload
 * stays inline too, so the load's hard sanitizer strips it exactly as today.
 *
 * Contract: `digestOf` answers only for payloads that were validated before
 * they were stored (the runtime's `known` map is filled after
 * `validImageDataUrl` and Rust's own check), so a known payload is not
 * re-validated here — a 6M-character regex per image per save is the cost
 * this avoids. Never mutates; the SAME node object for everything it leaves
 * alone.
 */
export function desktopRefsForStorage(
  nodes: readonly AppNode[],
  digestOf: (payload: string) => string | undefined,
  refHolders?: WeakSet<object>,
): { nodes: AppNode[]; missing: string[] } {
  const missing: string[] = [];
  const seenMissing = new Set<string>();
  let out: AppNode[] | null = null;
  for (let i = 0; i < nodes.length; i++) {
    const values = imageValuesOf(nodes[i]);
    if (!values) continue;
    const p = values.imageB64;
    let ref: string | undefined;
    if (typeof p === 'string' && p.length > 0) {
      const digest = digestOf(p);
      if (digest !== undefined && DIGEST_RE.test(digest)) {
        ref = desktopImageRef(digest);
      } else if (!seenMissing.has(p) && validImageDataUrl(p) !== null) {
        seenMissing.add(p);
        missing.push(p);
      }
    }
    if (ref === undefined && values[IMAGE_REF_KEY] === undefined) continue;
    const nv: Obj = { ...values };
    delete nv[IMAGE_REF_KEY];
    if (ref !== undefined) {
      nv.imageB64 = ''; // assigning an existing key keeps its position
      nv[IMAGE_REF_KEY] = ref;
      refHolders?.add(nv);
    }
    out ??= nodes.slice();
    out[i] = withValues(nodes[i], nv);
  }
  return { nodes: out ?? nodes.slice(), missing };
}

/**
 * The file store's JSON. An `imageRef` key survives only on the values objects
 * `desktopRefsForStorage` wrote a ref into (`refHolders`): autosave.rs refuses
 * a document whose `"imageRef":"fsimg-<hex>"` names an image that is not on
 * disk, and a stray key anywhere else — a crafted `.fastshader` can put one on
 * any node — would refuse that document's every later save.
 */
export function stringifyDesktopDocument(value: unknown, refHolders: WeakSet<object>): string {
  return JSON.stringify(value, function (this: unknown, key: string, v: unknown) {
    return key === IMAGE_REF_KEY && !(isObj(this) && refHolders.has(this)) ? undefined : v;
  });
}

// ---------------------------------------------------------------------------
// READER
// ---------------------------------------------------------------------------

/** Characters one document may resolve through file refs (the img1 reader's
 *  amplification guard, `MAX_REF_RESOLVED_IMAGE_CHARS`), charged ONCE per
 *  DISTINCT digest, in document order. ONE budget per document. Per instance
 *  would bound nothing — every instance shares the one cached string — while
 *  the library is budgeted per UNIQUE payload on write, so eleven groups
 *  sharing one 6M image are accepted without a notice and were then stripped
 *  at boot (66M per instance against 64M) and lost on the next write. */
export interface MaterializeBudget {
  chars: number;
  readonly max: number;
  /** The digests already charged to this document. */
  readonly charged: Set<string>;
}

export function newMaterializeBudget(max: number = MAX_REF_RESOLVED_IMAGE_CHARS): MaterializeBudget {
  return { chars: 0, max, charged: new Set() };
}

/**
 * Replace the file refs in a FRESHLY PARSED node list with the payloads they
 * name. `cache` (digest → payload, or null for one that could not be read) is
 * shared across both slots, so the graph and the library share one string per
 * image. A node whose image cannot be read, fails validation, or would take
 * the document past its budget KEEPS its ref: `resolveImageRefs` then counts it
 * dangling, and the N8 notice reports it. An inline payload beside a ref is
 * left alone (resolveImageRefs keeps the inline one). Never throws for a bad
 * node; returns a new array only when something changed.
 */
export async function materializeDesktopRefs(
  rawNodes: unknown[],
  bridge: Pick<DesktopAutosaveBridge, 'imageGet'>,
  cache: Map<string, string | null>,
  budget: MaterializeBudget = newMaterializeBudget(),
): Promise<unknown[]> {
  let out: unknown[] | null = null;
  for (let i = 0; i < rawNodes.length; i++) {
    const values = imageValuesOf(rawNodes[i]);
    if (!values) continue;
    const ref = values[IMAGE_REF_KEY];
    if (typeof ref !== 'string') continue;
    const m = DESKTOP_IMAGE_REF_RE.exec(ref);
    if (!m) continue;
    const inline = values.imageB64;
    if (typeof inline === 'string' && inline.length > 0) continue;
    const digest = m[1];
    if (!cache.has(digest)) {
      let payload: string | null = null;
      try {
        const got = await bridge.imageGet(digest);
        payload = validImageDataUrl(got);
      } catch {
        payload = null;
      }
      cache.set(digest, payload);
    }
    const payload = cache.get(digest) ?? null;
    if (payload === null) continue;
    if (!budget.charged.has(digest)) {
      if (budget.chars + payload.length > budget.max) continue;
      budget.chars += payload.length;
      budget.charged.add(digest);
    }
    const nv: Obj = { ...values };
    delete nv[IMAGE_REF_KEY];
    nv.imageB64 = payload;
    out ??= rawNodes.slice();
    out[i] = withValues(rawNodes[i], nv);
  }
  return out ?? rawNodes;
}

// ---------------------------------------------------------------------------
// SERIAL SAVER + RUNTIME
// ---------------------------------------------------------------------------

/**
 * One run at a time, and never a lost request: `request()` starts `run()` now
 * when idle, else marks the saver dirty, and a settled run with the dirty flag
 * set runs exactly once more (so any number of requests during one run cost
 * one more run, and that run reads the latest state). `flush()` resolves after
 * the in-flight run and any dirty re-run. `run` reports its own failures; a
 * rejection is swallowed here so it can never surface as an unhandled one.
 */
export function createSerialSaver(run: () => Promise<void>): { request(): void; flush(): Promise<void> } {
  let current: Promise<void> | null = null;
  let dirty = false;
  const start = (): Promise<void> => {
    const settled = run().then(
      () => undefined,
      () => undefined,
    );
    const chain: Promise<void> = settled.then(() => {
      if (dirty) {
        dirty = false;
        return start();
      }
      current = null;
      return undefined;
    });
    current = chain;
    return chain;
  };
  return {
    request() {
      if (current) dirty = true;
      else void start();
    },
    async flush() {
      while (current) await current;
    },
  };
}

export interface DesktopAutosaveHooks {
  onWriteFailed(reason: string): void;
  onWriteOk(slot: DesktopSlot): void;
}

export interface DesktopAutosaveRuntime {
  /** Record the latest document for `slot`; written only while writes are enabled. */
  save(slot: DesktopSlot, doc: () => DesktopDocument): void;
  /** Start writing, and write every slot that already has a pending document.
   *  `before` (the boot's GC) is awaited ahead of the first write. */
  enableWrites(before?: Promise<unknown>): void;
  /** Forget the pending documents (a boot-time store change the seed replaces). */
  dropPending(): void;
  readonly writesEnabled: boolean;
  flush(): Promise<void>;
  /** payload → digest pairs the boot read, so an unchanged image is never put again. */
  seedKnown(entries: Iterable<[string, string]>): void;
}

export function createDesktopAutosave(
  bridge: DesktopAutosaveBridge,
  hooks: DesktopAutosaveHooks,
): DesktopAutosaveRuntime {
  const latest = new Map<DesktopSlot, () => DesktopDocument>();
  /** payload → digest, for payloads that were validated and are on disk. */
  const known = new Map<string, string>();
  const lastPayloads = new Map<DesktopSlot, Set<string>>();
  /** What the boot read. Kept in `known` until BOTH slots have written once,
   *  or the first graph write would forget the library's images. */
  const seeded = new Set<string>();
  let writesEnabled = false;
  let failing = false;
  let gate: Promise<unknown> = Promise.resolve();
  /** payload → its put in flight. The two slots' savers run concurrently, and
   *  both would put the same new image at once (the first desktop boot
   *  migrates a graph and a library that share one): they share ONE put. */
  const inflight = new Map<string, Promise<string>>();

  const putImage = (p: string): Promise<string> => {
    let put = inflight.get(p);
    if (put === undefined) {
      put = bridge
        .imagePut(p)
        .then((digest) => {
          if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw new Error('E_BAD_DIGEST');
          known.set(p, digest);
          return digest;
        })
        .finally(() => inflight.delete(p));
      inflight.set(p, put);
    }
    return put;
  };

  const prune = () => {
    const keep = new Set<string>();
    for (const set of lastPayloads.values()) for (const p of set) keep.add(p);
    if (lastPayloads.size < DESKTOP_SLOTS.length) for (const p of seeded) keep.add(p);
    else seeded.clear();
    for (const p of [...known.keys()]) if (!keep.has(p)) known.delete(p);
  };

  const writeOnce = async (slot: DesktopSlot, thunk: () => DesktopDocument) => {
    const doc = thunk();
    const payloads: string[] = [];
    const listed = new Set<string>();
    for (const n of doc.nodes) {
      const p = imageValuesOf(n)?.imageB64;
      if (typeof p !== 'string' || p.length === 0 || listed.has(p)) continue;
      if (!known.has(p) && validImageDataUrl(p) === null) continue;
      listed.add(p);
      payloads.push(p);
    }
    for (const p of payloads) if (!known.has(p)) await putImage(p);
    const refHolders = new WeakSet<object>();
    const value = doc.build((nodes) => desktopRefsForStorage(nodes, (p) => known.get(p), refHolders).nodes);
    await bridge.write(slot, new TextEncoder().encode(stringifyDesktopDocument(value, refHolders)));
    lastPayloads.set(slot, listed);
    prune();
    failing = false;
    hooks.onWriteOk(slot);
  };

  const report = (e: unknown) => {
    if (failing) return;
    failing = true;
    hooks.onWriteFailed(describeDesktopError(e));
  };

  const runSlot = async (slot: DesktopSlot) => {
    const thunk = latest.get(slot);
    if (!thunk) return;
    await gate;
    try {
      await writeOnce(slot, thunk);
    } catch (e) {
      // An image file vanished under a digest this session still trusted (the
      // boot GC, or someone emptying the folder): forget it and put again.
      const parsed = parseDesktopError(e);
      if (parsed?.code !== 'MISSING_IMAGE') {
        report(e);
        return;
      }
      const lost = parsed.detail;
      for (const [p, d] of [...known]) if (lost === undefined || d === lost) known.delete(p);
      try {
        await writeOnce(slot, latest.get(slot) ?? thunk);
      } catch (e2) {
        report(e2);
      }
    }
  };

  const savers: Record<DesktopSlot, ReturnType<typeof createSerialSaver>> = {
    graph: createSerialSaver(() => runSlot('graph')),
    savedGroups: createSerialSaver(() => runSlot('savedGroups')),
  };

  return {
    save(slot, doc) {
      latest.set(slot, doc);
      if (writesEnabled) savers[slot].request();
    },
    enableWrites(before) {
      if (before) gate = before.then(
        () => undefined,
        () => undefined,
      );
      writesEnabled = true;
      for (const slot of DESKTOP_SLOTS) if (latest.has(slot)) savers[slot].request();
    },
    dropPending() {
      latest.clear();
    },
    get writesEnabled() {
      return writesEnabled;
    },
    async flush() {
      await Promise.all(DESKTOP_SLOTS.map((slot) => savers[slot].flush()));
    },
    seedKnown(entries) {
      for (const [p, d] of entries) {
        if (typeof p !== 'string' || p.length === 0 || !DIGEST_RE.test(d)) continue;
        known.set(p, d);
        seeded.add(p);
      }
    },
  };
}

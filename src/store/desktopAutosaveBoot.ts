/**
 * The desktop room's autosave BOOT (GLB Phase 6, S6): read the file store
 * before the graph is seeded, install the runtime, and answer Rust's close/quit
 * flush.
 *
 * Imported ONLY through the dynamic `import()` in App.tsx's `__FS_DESKTOP__`
 * branch, so it ships in a desktop-only chunk and the web bundle never carries
 * it. Every bridge call is bounded by {@link BOOT_CALL_TIMEOUT_MS}, so a hung
 * IPC cannot leave the boot overlay up forever.
 *
 * The rules, each a way the store loses work otherwise:
 * - Writes stay OFF until the graph has been seeded (`start()`), and the
 *   documents any boot-time store change left pending are DROPPED then: the
 *   first file write must be the seeded graph, never the empty store a mount
 *   effect happened to touch — that write would rotate the real document into
 *   the backup and put the empty one in front of it.
 * - A read that FAILS (I/O, not "absent", not "corrupt") pauses writes for the
 *   whole session and says so: an unreadable file must never be overwritten.
 *   An IMAGE read counts too, unless it found the file missing or corrupt:
 *   the next write would drop a still-good ref and the next GC its file.
 * - A document that does not parse is QUARANTINED (renamed aside, never
 *   deleted) and the one-deep backup is read instead, silently. When no
 *   document in the slot parses, that is a failed read as well: a silent
 *   migration would show a stale copy, and the second write would rotate the
 *   unreadable backup away.
 * - Both files absent: the localStorage `fs:graph` / `fs:savedGroups` are the
 *   one-time migration source. They are left in place and no longer written.
 */
import {
  flushPendingGraphSave,
  installDesktopAutosave,
  installedDesktopAutosave,
  loadGraph,
  loadSavedGroupsReport,
  parseStoredGraph,
  parseStoredGroupsReport,
  persistSavedGroups,
  useAppStore,
  type StoredGraph,
  type StoredGroupsReport,
} from './useAppStore';
import { generateId } from '@/utils/idGenerator';
import { safeJsonReviver } from '@/utils/safeJson';
import { describeDesktopError, parseDesktopError } from '@/utils/desktopIpc';
import { t } from '@/i18n';
import {
  AUTOSAVE_FLUSH_EVENT,
  DESKTOP_AUTOSAVE_MARKER_KEY,
  createDesktopAutosave,
  materializeDesktopRefs,
  newMaterializeBudget,
  tauriAutosaveBridge,
  type DesktopAutosaveBridge,
  type DesktopSlot,
} from '@/utils/desktopAutosave';

/** Bound on each bridge call during boot, so a hung IPC cannot keep the boot
 *  overlay up forever — and on the first write's GC, where that rationale does
 *  NOT apply (`start()` runs after the overlay is down) and the bound is not a
 *  correctness device either: opening the gate early is a write racing a
 *  still-running GC, which autosave.rs makes harmless by claiming every digest
 *  this process stores and checking the claim inside the same critical section
 *  as its delete (`StoredImages`). Here it only keeps a wedged `gc()` from
 *  pausing this session's autosave for good — which is why it may not simply
 *  be dropped. */
export const BOOT_CALL_TIMEOUT_MS = 10_000;

export interface DesktopBootResult {
  graph: StoredGraph | null;
  /** Both counts ride along: the slot reads run the web loaders' own
   *  sanitisers (`parseStoredGroupsReport`), so N8 and decision 9 exist here too. */
  groups: StoredGroupsReport;
  /** Call right AFTER the graph is seeded: drops what boot-time store changes
   *  left pending, writes the seeded graph, and enables writes (unless a read
   *  failed, which pauses them for the session). Idempotent. */
  start(): void;
}

/** The image-read answers that mean "this ref is gone" — the file is missing,
 *  fails its hash, or the ref is not a digest at all: the node keeps a dangling
 *  ref for N8, and the next write drops it. Any OTHER rejection (I/O, a
 *  permission, the boot timeout) says nothing about the file, so it is a failed
 *  READ: writes pause, and a still-good image is never dropped and collected. */
const DANGLING_IMAGE_CODES: ReadonlySet<string> = new Set(['NOT_FOUND', 'CORRUPT_IMAGE', 'BAD_DIGEST']);

function withTimeout<T>(p: Promise<T>, ms: number = BOOT_CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type SlotRead<T> = { kind: 'ok'; value: T } | { kind: 'absent' } | { kind: 'failed'; reason: string };

/** Decode, parse and hand to `parse`; null for anything that is not a valid
 *  document (corrupt UTF-8, bad JSON, the wrong shape). */
async function tryParse<T>(bytes: Uint8Array, parse: (doc: unknown) => Promise<T | null>): Promise<T | null> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return await parse(JSON.parse(text, safeJsonReviver));
  } catch {
    return null;
  }
}

/** The `{reason}` of the read-failed notice when no document in the slot
 *  parsed: the one reason the boot itself words (the others are Rust's). */
const damaged = (line: string): string => t(line, useAppStore.getState().language);

/** current → (quarantine if corrupt) → previous → absent. A REJECTED read is a
 *  failure, which the caller must not answer with a write — and so is a slot
 *  where a document existed and none parsed: migrating silently would show a
 *  stale copy, and the second write would rotate the unreadable backup away. */
async function readSlot<T>(
  bridge: DesktopAutosaveBridge,
  slot: DesktopSlot,
  parse: (doc: unknown) => Promise<T | null>,
): Promise<SlotRead<T>> {
  try {
    const current = await withTimeout(bridge.read(slot, 'current'));
    const currentDamaged = current.length > 0;
    if (currentDamaged) {
      const value = await tryParse(current, parse);
      if (value !== null) return { kind: 'ok', value };
      await withTimeout(bridge.quarantine(slot));
    }
    const previous = await withTimeout(bridge.read(slot, 'previous'));
    if (previous.length > 0) {
      const value = await tryParse(previous, parse);
      if (value !== null) return { kind: 'ok', value };
      return { kind: 'failed', reason: damaged(currentDamaged ? 'the file and its backup are both damaged' : 'its backup is damaged') };
    }
    if (currentDamaged) return { kind: 'failed', reason: damaged('the file is damaged and there is no backup') };
    return { kind: 'absent' };
  } catch (e) {
    return { kind: 'failed', reason: describeDesktopError(e) };
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Read both documents from the file store and install the runtime. Null when
 * the store is not there at all (a desktop bundle run in a plain browser, or no
 * app data directory): App then boots from localStorage with web behaviour and
 * no notice.
 */
export async function bootDesktopAutosave(
  bridge: DesktopAutosaveBridge = tauriAutosaveBridge(),
): Promise<DesktopBootResult | null> {
  try {
    await withTimeout(bridge.status());
  } catch {
    return null;
  }

  const runtime = createDesktopAutosave(bridge, {
    onWriteFailed: (reason) =>
      useAppStore.getState().enqueueLimitNotice({
        id: generateId(),
        kind: 'autosave-file-failed',
        detail: reason,
      }),
    onWriteOk: (slot) => {
      if (slot !== 'graph') return;
      try {
        localStorage.setItem(DESKTOP_AUTOSAVE_MARKER_KEY, '1');
      } catch {
        /* the marker only gates the viewport memory */
      }
    },
  });
  // Installed at once, writes off: a store change during boot is captured,
  // never written (and dropped again by start()).
  installDesktopAutosave(runtime);

  try {
    // Shared across both slots: one string per image in the graph and the library.
    const cache = new Map<string, string | null>();
    let readFailed: string | null = null;
    // Image reads are bounded too. Missing or corrupt leaves the ref dangling
    // (N8); any other failure (I/O, a permission, the timeout) is a failed
    // read, so writes pause and the still-good image file is never collected.
    const images: Pick<DesktopAutosaveBridge, 'imageGet'> = {
      imageGet: (digest) =>
        withTimeout(bridge.imageGet(digest)).catch((e: unknown) => {
          if (!DANGLING_IMAGE_CODES.has(parseDesktopError(e)?.code ?? '')) readFailed ??= describeDesktopError(e);
          throw e;
        }),
    };

    const graphRead = await readSlot(bridge, 'graph', async (doc) => {
      if (!isObj(doc) || !Array.isArray(doc.nodes)) return null;
      doc.nodes = await materializeDesktopRefs(doc.nodes, images, cache, newMaterializeBudget());
      return parseStoredGraph(doc);
    });
    const groupsRead = await readSlot(bridge, 'savedGroups', async (doc) => {
      if (!Array.isArray(doc)) return null;
      // ONE budget for the whole library, spent in group order.
      const budget = newMaterializeBudget();
      for (const g of doc) {
        if (isObj(g) && Array.isArray(g.nodes)) {
          g.nodes = await materializeDesktopRefs(g.nodes, images, cache, budget);
        }
      }
      return parseStoredGroupsReport(doc);
    });

    let graph: StoredGraph | null;
    if (graphRead.kind === 'ok') graph = graphRead.value;
    else {
      if (graphRead.kind === 'failed') readFailed ??= graphRead.reason;
      graph = loadGraph();
    }
    let groups: StoredGroupsReport;
    let groupsMigrated = false;
    if (groupsRead.kind === 'ok') groups = groupsRead.value;
    else {
      if (groupsRead.kind === 'failed') readFailed ??= groupsRead.reason;
      groupsMigrated = groupsRead.kind === 'absent';
      groups = loadSavedGroupsReport();
    }

    const seed: Array<[string, string]> = [];
    for (const [digest, payload] of cache) if (payload !== null) seed.push([payload, digest]);
    runtime.seedKnown(seed);

    if (readFailed !== null) {
      useAppStore.getState().enqueueLimitNotice({
        id: generateId(),
        kind: 'autosave-file-read-failed',
        detail: readFailed,
      });
    }

    let started = false;
    return {
      graph,
      groups,
      start() {
        if (started) return;
        started = true;
        if (readFailed !== null) return;
        runtime.dropPending();
        // The seed armed the 300 ms autosave with the seeded graph: take it now,
        // so the first file write is that graph.
        flushPendingGraphSave();
        // A library migrated from localStorage becomes a file at once, rather
        // than waiting for its next edit: localStorage may be cleared by then.
        // So does one the load had to repair: App's write-back of it was
        // captured while writes were off and dropped just above, and the file
        // would keep its dangling ref and raise the N8 notice every launch —
        // or keep its over-cap Output sections and raise the decision-9 notice
        // (`outputSectionsTrimmed`) every launch, the web write-back's other
        // condition (App.tsx `seedFromStored`).
        if (
          (groupsMigrated && groups.groups.length > 0) ||
          groups.strippedImages > 0 ||
          groups.outputSectionsTrimmed > 0
        ) {
          persistSavedGroups(groups.groups);
        }
        // The GC runs before the first write so its keep set is read from the
        // documents this boot read. A pass that merely takes too long opens
        // the gate exactly as a finished one does, and that is deliberately
        // survivable rather than prevented here — see BOOT_CALL_TIMEOUT_MS.
        runtime.enableWrites(withTimeout(bridge.gc()).catch(() => undefined));
      },
    };
  } catch {
    // Unexpected: fall back to today's localStorage behaviour, not a dead store.
    installDesktopAutosave(null);
    return null;
  }
}

/**
 * Rust asks for a flush on window close / app quit (`fs:autosave-flush`):
 * run the pending autosave now, wait for the file writes, then answer
 * `autosave_close_ready` — always, or the close waits out Rust's 3 s timeout.
 */
export async function answerDesktopCloseFlush(
  bridge: Pick<DesktopAutosaveBridge, 'closeReady'>,
): Promise<void> {
  try {
    flushPendingGraphSave();
    await installedDesktopAutosave()?.flush();
  } catch {
    /* answer anyway */
  } finally {
    await bridge.closeReady().catch(() => undefined);
  }
}

let closeFlushRegistered = false;

/** Registered in EVERY desktop session, the localStorage fallback included —
 *  without a listener each close would wait out Rust's 3 s timeout. */
export function registerDesktopCloseFlush(
  bridge: Pick<DesktopAutosaveBridge, 'closeReady'> = tauriAutosaveBridge(),
): void {
  if (closeFlushRegistered) return;
  const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
  if (!tauri?.event?.listen) return;
  closeFlushRegistered = true;
  void tauri.event
    .listen(AUTOSAVE_FLUSH_EVENT, () => {
      void answerDesktopCloseFlush(bridge);
    })
    .catch(() => {
      closeFlushRegistered = false;
    });
}
